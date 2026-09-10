import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, rm, stat} from "node:fs/promises";
import {once} from "node:events";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {BrowserExtension, browserAvailable, browserRequest} from "../browser.mjs";
import {chromiumFlags} from "../browser-config.mjs";

const native = fileURLToPath(new URL("../browser-native.mjs", import.meta.url));

test("browser integration preserves existing extensions and reverses only its own registration", () => {
  const original = "--ozone-platform=wayland\n--load-extension=/first,/second\n";
  const configured = chromiumFlags(original,"/super-space",true);
  assert.equal(chromiumFlags(configured,"/super-space",true), configured);
  assert.equal(chromiumFlags(configured,"/super-space",false), original);
  const quoted = chromiumFlags("--load-extension='/first path'\n", "/second path", true);
  assert.equal(quoted,"'--load-extension=/first path,/second path'\n");
  assert.equal(chromiumFlags("--ozone-platform=wayland\n", "/super-space", false), "--ozone-platform=wayland\n");
});
async function bridge(t, handler) {
  const directory = await mkdtemp(path.join(tmpdir(), "cs-browser-"));
  const previous = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = directory;
  const child = spawn(process.execPath, [native], {env:{...process.env}});
  let input = Buffer.alloc(0), ready;
  const startup = new Promise(resolve => {ready = resolve;});
  const send = async message => {
    const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    child.stdin.write(header.subarray(0, 2));
    await new Promise(resolve => setTimeout(resolve, 2));
    child.stdin.write(Buffer.concat([header.subarray(2), body]));
  };
  child.stdout.on("data", chunk => {
    input = Buffer.concat([input, chunk]);
    while (input.length >= 4 && input.length >= input.readUInt32LE(0) + 4) {
      const length = input.readUInt32LE(0), message = JSON.parse(input.subarray(4, 4 + length));
      input = input.subarray(4 + length);
      if (message.type === "ready") ready(); else void send(handler(message));
    }
  });
  t.after(async () => {
    if (child.exitCode === null && !child.killed) { child.kill(); await once(child, "exit"); }
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = previous;
    await rm(directory, {recursive:true, force:true});
  });
  await Promise.race([startup, new Promise((_, reject) => setTimeout(() => reject(new Error("Browser bridge did not start")), 3000).unref())]);
  return {child, directory, socket:path.join(directory, "super-space-browser", `${child.pid}.sock`)};
}

test("browser API crosses native framing and a private socket, preserving Unicode and errors", async t => {
  const tabs = [{id:42, url:"https://fixture.invalid/", title:"Café 🎄", active:true}];
  const host = await bridge(t, message => message.method === "getTabs" ? {id:message.id, result:tabs} : {id:message.id, error:"The selected tab was closed"});
  assert.equal(browserAvailable(), true);
  assert.equal((await stat(path.dirname(host.socket))).mode & 0o777, 0o700);
  assert.equal((await stat(host.socket)).mode & 0o777, 0o600);
  assert.deepEqual(await BrowserExtension.getTabs(), tabs);
  await assert.rejects(BrowserExtension.getContent({tabId:42, format:"text"}), /tab was closed/);
  await assert.rejects(BrowserExtension.getContent({cssSelector:"main"}), /cannot be used with markdown/);
  await assert.rejects(browserRequest("executeScript"), /Unknown browser method/);
  host.child.stdin.end();
  await once(host.child, "exit");
  assert.equal(browserAvailable(), false);
  await assert.rejects(stat(host.socket), {code:"ENOENT"});
});

test("browser native host rejects oversized framing and cleans up its socket", async t => {
  const host = await bridge(t, () => ({}));
  const header = Buffer.alloc(4); header.writeUInt32LE(21 * 1024 * 1024);
  host.child.stdin.write(header);
  const [code] = await once(host.child, "exit");
  assert.equal(code, 1);
  assert.equal(browserAvailable(), false);
});
