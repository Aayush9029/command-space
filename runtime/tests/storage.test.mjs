import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {execFile, spawn} from "node:child_process";
import {once} from "node:events";
import {promisify} from "node:util";
import {readStore, updateStore} from "../storage.mjs";

const run = promisify(execFile);
const storageModule = new URL("../storage.mjs", import.meta.url).href;
const apiModule = new URL("../api.mjs", import.meta.url).href;

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "command-space-storage-"));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  return directory;
}

test("concurrent invocation storage and cache writes preserve every key and namespace", async t => {
  const directory = await fixture(t);
  await Promise.all(Array.from({length: 6}, (_, worker) => run(process.execPath, ["--input-type=module", "-e", `
    import {LocalStorage, Cache} from ${JSON.stringify(apiModule)};
    globalThis.__commandSpace = {environment: {supportPath: ${JSON.stringify(directory)}}};
    const cache = new Cache({namespace: "shared"}), own = new Cache({namespace: "worker-${worker}"});
    for (let index = 0; index < 12; index++) {
      await LocalStorage.setItem("${worker}:" + index, index);
      cache.set("${worker}:" + index, "cached");
      own.set(String(index), "isolated");
    }
  `], {timeout: 15000})));
  const values = readStore(path.join(directory, "storage.json"));
  const cache = readStore(path.join(directory, "cache.json"));
  assert.equal(Object.keys(values).length, 72);
  assert.equal(Object.keys(cache.shared).length, 72);
  for (let worker = 0; worker < 6; worker++) {
    for (let index = 0; index < 12; index++) {
      assert.equal(values[`${worker}:${index}`], index);
      assert.equal(cache.shared[`${worker}:${index}`], "cached");
      assert.equal(cache[`worker-${worker}`][index], "isolated");
    }
  }
  assert.equal((await fs.stat(path.join(directory, "storage.json"))).mode & 0o777, 0o600);
});

test("a killed invocation releases its storage lock without persisting partial changes", async t => {
  const file = path.join(await fixture(t), "values.json");
  updateStore(file, values => { values.retained = "original"; });
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {updateStore} from ${JSON.stringify(storageModule)};
    updateStore(${JSON.stringify(file)}, values => {
      values.retained = "unfinished";
      process.kill(process.pid, "SIGKILL");
    });
  `], {stdio: "ignore"});
  const [, signal] = await once(child, "close");
  assert.equal(signal, "SIGKILL");
  updateStore(file, values => { values.next = "works"; });
  assert.deepEqual(readStore(file), {retained: "original", next: "works"});
});

test("failed storage serialization preserves the original file and releases the lock", async t => {
  const file = path.join(await fixture(t), "values.json");
  updateStore(file, values => { values.retained = true; });
  assert.throws(() => updateStore(file, values => { values.circular = values; }), /circular/i);
  updateStore(file, values => { values.next = true; });
  assert.deepEqual(readStore(file), {retained: true, next: true});
  assert(!(await fs.readdir(path.dirname(file))).some(name => name.endsWith(".tmp")));
});
