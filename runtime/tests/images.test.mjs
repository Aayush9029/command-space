import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createImages } from "../images.mjs";

test("remote extension images are downloaded, rendered from disk, and reused across workers", async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(),"command-space-images-"));
  const content = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="red"/></svg>';
  let count = 0;
  const server = http.createServer((req,res) => { count++; assert.equal(req.headers["x-image-token"],"fixture"); res.writeHead(200,{"Content-Type":"image/svg+xml"}); res.end(content); });
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(async () => {server.close(); delete globalThis.__commandSpace; await fs.rm(folder,{recursive:true,force:true});});
  globalThis.__commandSpace = {environment:{supportPath:folder,assetsPath:folder}};
  let changed;
  const ready = new Promise(resolve => {changed = resolve;});
  const resolve = createImages(changed);
  const icon = {uri:`http://127.0.0.1:${server.address().port}/icon`,headers:{"x-image-token":"fixture"}};
  resolve({icon}); await ready;
  const file = resolve({icon}).icon;
  assert.equal(await fs.readFile(file,"utf8"),content);
  const restored = createImages(() => {});
  assert.equal(restored({icon}).icon,file);
  assert.equal(count,1);
  assert.equal(restored({icon:""}).icon,"");
  assert.equal(restored({icon:"file://%"}).icon,"󰋩");
});
