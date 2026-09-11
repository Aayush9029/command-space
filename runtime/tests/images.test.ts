import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createImages } from "../images.ts";
import { resolveIcon } from "../icon-catalog.ts";
import {isRecord} from "../types.ts";

function address(server: http.Server): string {
  const value = server.address();
  assert.ok(value && typeof value === "object");
  return `http://127.0.0.1:${value.port}`;
}
function record(value: unknown): Record<string, unknown> { assert.ok(isRecord(value)); return value; }
function string(value: unknown): string { assert.ok(typeof value === "string"); return value; }

test("remote extension images are downloaded, rendered from disk, and reused across workers", async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(),"super-space-images-"));
  const content = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="red"/></svg>';
  let count = 0;
  const server = http.createServer((req,res) => { count++; assert.equal(req.headers["x-image-token"],"fixture"); res.writeHead(200,{"Content-Type":"image/svg+xml"}); res.end(content); });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(async () => {server.close(); delete globalThis.__superSpace; await fs.rm(folder,{recursive:true,force:true});});
  globalThis.__superSpace = {environment:{supportPath:folder,assetsPath:folder}};
  let changed: () => void = () => {};
  const ready = new Promise<void>(resolve => {changed = resolve;});
  const resolve = createImages(changed);
  const icon = {uri:`${address(server)}/icon`,headers:{"x-image-token":"fixture"}};
  resolve({icon}); await ready;
  const file = string(resolve({icon}).icon);
  assert.equal(await fs.readFile(file,"utf8"),content);
  const restored = createImages(() => {});
  assert.equal(restored({icon}).icon,file);
  assert.equal(count,1);
  assert.equal(restored({icon:""}).icon,"");
  assert.equal(restored({icon:"file://%"}).icon,"󰋩");
});

test("embedded avatars and failed remote images preserve masks, tints and fallbacks", async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(),"super-space-image-fallback-"));
  const server = http.createServer((_req,res) => {res.writeHead(503);res.end();});
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{server.close(); delete globalThis.__superSpace; await fs.rm(folder,{recursive:true,force:true});});
  globalThis.__superSpace = {environment:{supportPath:folder,assetsPath:folder}};
  let changed: () => void = () => {};
  const ready = new Promise<void>(resolve=>{changed=resolve;});
  const resolve = createImages(changed);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><text y="24">CS</text></svg>';
  const icon = record(resolve({icon:{source:`data:image/svg+xml,${encodeURIComponent(svg)}`,mask:"circle",tintColor:"red"}}).icon);
  assert.equal(await fs.readFile(string(icon.source),"utf8"),svg);
  assert.equal(icon.mask,"circle"); assert.equal(icon.tintColor,"red");
  const remote = {source:`${address(server)}/missing`,fallback:"icon:Star"};
  resolve({icon:remote}); await ready;
  assert.equal(record(resolve({icon:remote}).icon).source,resolveIcon("Star"));
});


test("named icons preserve explicit tint, masks, adaptive sources, and accessory icons", () => {
  globalThis.__superSpace = {environment:{appearance:"dark"}};
  try {
    const resolve = createImages(() => {});
    const values = resolve({icon:{source:{light:"icon:Sun",dark:"icon:Moon"},tintColor:"red",mask:"circle"},accessories:[{icon:"icon:CheckCircle",text:"Ready"}]});
    assert.equal(record(values.icon).source,resolveIcon("Moon"));
    assert.equal(record(values.icon).tintColor,"red");
    assert.equal(record(values.icon).mask,"circle");
    assert.ok(Array.isArray(values.accessories));
    const accessory = record(record(values.accessories[0]).icon);
    assert.equal(accessory.source,resolveIcon("CheckCircle"));
    assert.equal(accessory.tintColor,"primarytext");
  } finally { delete globalThis.__superSpace; }
});

test("non-image HTTP responses fall back without caching HTML as a PNG", async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(),"super-space-image-content-"));
  const server = http.createServer((_req,res) => {res.writeHead(200,{"Content-Type":"image/png"});res.end("<html>Rate limit</html>");});
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{server.close();delete globalThis.__superSpace;await fs.rm(folder,{recursive:true,force:true});});
  globalThis.__superSpace = {environment:{supportPath:folder}};
  let changed: () => void = () => {};
  const ready = new Promise<void>(resolve => {changed=resolve;});
  const resolve = createImages(changed);
  const icon = {source:{uri:`${address(server)}/bad`},fallback:"icon:Warning"};
  resolve({icon}); await ready;
  assert.equal(record(resolve({icon}).icon).source,resolveIcon("Warning"));
  assert.deepEqual(await fs.readdir(folder),[]);
});

test("embedded image cache evicts old files at its bounded entry limit", async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(),"super-space-image-budget-"));
  t.after(async()=>{delete globalThis.__superSpace;await fs.rm(folder,{recursive:true,force:true});});
  globalThis.__superSpace = {environment:{supportPath:folder}};
  const resolve = createImages(() => {});
  for (let index=0;index<260;index++) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path id="item-${index}" d="M0 0h16v16H0z"/></svg>`;
    const icon = resolve({icon:`data:image/svg+xml,${encodeURIComponent(svg)}`}).icon;
    assert.equal(typeof icon,"string");
  }
  assert.equal((await fs.readdir(path.join(folder,"image-cache"))).length,256);
});

test("GIF avatars and ICO/BMP icons retain their detected formats", async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(),"super-space-image-formats-"));
  t.after(async()=>{delete globalThis.__superSpace;await fs.rm(folder,{recursive:true,force:true});});
  globalThis.__superSpace = {environment:{supportPath:folder}};
  const resolve = createImages(() => {});
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1cAAAAASUVORK5CYII=", "base64");
  const ico = Buffer.alloc(22 + png.length);
  ico.writeUInt16LE(1,2); ico.writeUInt16LE(1,4);
  ico[6]=1; ico[7]=1; ico.writeUInt16LE(1,10); ico.writeUInt16LE(32,12);
  ico.writeUInt32LE(png.length,14); ico.writeUInt32LE(22,18); png.copy(ico,22);
  const bmp = Buffer.alloc(58);
  bmp.write("BM"); bmp.writeUInt32LE(58,2); bmp.writeUInt32LE(54,10); bmp.writeUInt32LE(40,14);
  bmp.writeInt32LE(1,18); bmp.writeInt32LE(1,22); bmp.writeUInt16LE(1,26); bmp.writeUInt16LE(24,28); bmp.writeUInt32LE(4,34);
  for (const [format,mime,bytes] of [["gif","gif",gif],["ico","vnd.microsoft.icon",ico],["bmp","bmp",bmp]] as const) {
    const source = string(resolve({icon:`data:image/${mime};base64,${bytes.toString("base64")}`}).icon);
    assert.equal(path.extname(source),`.${format}`);
    assert.deepEqual(await fs.readFile(source),bytes);
  }
  gif.writeUInt16LE(5000,6);
  assert.equal(record(resolve({icon:{source:`data:image/gif;base64,${gif.toString("base64")}`,fallback:"icon:Person"}}).icon).source,resolveIcon("Person"));
});

test("pending image downloads stay deduplicated when rejected requests evict cache entries", {timeout:10000}, async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(),"super-space-image-backlog-"));
  const originalFetch = globalThis.fetch;
  const requests = new Map<string, number>();
  const waiting: (() => void)[] = [];
  let active = 0, peak = 0, completed = 0, autoResolve = false;
  let firstChanged: () => void = () => {};
  let allChanged: () => void = () => {};
  const first = new Promise<void>(resolve => { firstChanged = resolve; });
  const all = new Promise<void>(resolve => { allChanged = resolve; });
  const content = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path d="M0 0h16v16H0z"/></svg>';
  globalThis.fetch = Object.assign((input: string | URL | Request): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    requests.set(url, (requests.get(url) ?? 0) + 1);
    active++;
    peak = Math.max(peak, active);
    return new Promise<Response>(resolve => {
      const finish = () => { active--; resolve(new Response(content)); };
      if (autoResolve) finish();
      else waiting.push(finish);
    });
  }, {preconnect:originalFetch.preconnect});
  t.after(async () => {
    autoResolve = true;
    for (const finish of waiting.splice(0)) finish();
    globalThis.fetch = originalFetch;
    delete globalThis.__superSpace;
    await fs.rm(folder,{recursive:true,force:true});
  });
  globalThis.__superSpace = {environment:{supportPath:folder}};
  const resolve = createImages(() => {
    completed++;
    firstChanged();
    if (completed >= 132) allChanged();
  });
  const icon = "https://images.example/held-0";
  for (let index = 0; index < 4; index++) resolve({icon:`https://images.example/held-${index}`});
  for (let index = 0; index < 128; index++) resolve({icon:`https://images.example/queued-${index}`});
  for (let index = 0; index < 600; index++) resolve({icon:`https://images.example/rejected-${index}`});
  assert.equal(requests.size,4);
  waiting.pop()?.();
  await first;
  await new Promise<void>(resolve => setImmediate(resolve));
  for (let index = 0; index < 20; index++) assert.equal(resolve({icon}).icon,"󰋩");
  autoResolve = true;
  for (const finish of waiting.splice(0)) finish();
  await all;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(requests.get(icon),1);
  assert.equal(requests.size,132);
  assert.equal(completed,132);
  assert.equal(peak,4);
  assert.equal(active,0);
  const source = string(resolve({icon}).icon);
  assert.equal(await fs.readFile(source,"utf8"),content);
});
