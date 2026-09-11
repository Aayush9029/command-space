import test, {type TestContext} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {execFile, spawn} from "node:child_process";
import {once} from "node:events";
import {promisify} from "node:util";
import {readStore, updateStore} from "../storage.ts";
import {isRecord} from "../types.ts";

const run = promisify(execFile);
const storageModule = new URL("../storage.ts", import.meta.url).href;
const apiModule = new URL("../api.ts", import.meta.url).href;

async function fixture(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "super-space-storage-"));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  return directory;
}

test("concurrent invocation storage and cache writes preserve every key and namespace", async t => {
  const directory = await fixture(t);
  await Promise.all(Array.from({length: 6}, (_, worker) => run(process.execPath, ["--input-type=module", "-e", `
    import {LocalStorage, Cache} from ${JSON.stringify(apiModule)};
    globalThis.__superSpace = {environment: {supportPath: ${JSON.stringify(directory)}}};
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
  const shared = cache.shared;
  assert.ok(isRecord(shared));
  assert.equal(Object.keys(shared).length, 72);
  for (let worker = 0; worker < 6; worker++) {
    const workerCache = cache[`worker-${worker}`];
    assert.ok(isRecord(workerCache));
    for (let index = 0; index < 12; index++) {
      assert.equal(values[`${worker}:${index}`], index);
      assert.equal(shared[`${worker}:${index}`], "cached");
      assert.equal(workerCache[index], "isolated");
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
  assert.throws(() => updateStore(file, values => { values.circular = values; }), /circular|cyclic/i);
  updateStore(file, values => { values.next = true; });
  assert.deepEqual(readStore(file), {retained: true, next: true});
  assert(!(await fs.readdir(path.dirname(file))).some(name => name.endsWith(".tmp")));
});

test("storage rejects malformed roots without overwriting the original file", async t => {
  const file = path.join(await fixture(t), "values.json");
  assert.deepEqual(readStore(file), {});
  for (const serialized of ["null", "[]", "true", "42", '"string"', "{invalid"]) {
    await fs.writeFile(file, serialized);
    assert.throws(() => readStore(file));
    assert.throws(() => updateStore(file, values => { values.changed = true; }));
    assert.equal(await fs.readFile(file, "utf8"), serialized);
  }
});

test("failed storage updates discard in-memory changes and release the lock", async t => {
  const file = path.join(await fixture(t), "values.json");
  updateStore(file, values => { values.retained = "original"; });
  assert.throws(() => updateStore(file, values => { values.retained = "changed"; throw new Error("Update failed"); }), /Update failed/);
  updateStore(file, values => { values.next = "works"; });
  assert.deepEqual(readStore(file), {retained: "original", next: "works"});
  assert(!(await fs.readdir(path.dirname(file))).some(name => name.endsWith(".tmp")));
});

test("storage treats prototype property names as literal keys and cache namespaces", async t => {
  const directory = await fixture(t);
  await run(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import {LocalStorage, Cache} from ${JSON.stringify(apiModule)};
    globalThis.__superSpace = {environment: {supportPath: ${JSON.stringify(directory)}}};
    const keys = ["__proto__", "constructor", "toString"];
    for (const key of keys) assert.equal(await LocalStorage.getItem(key), undefined);
    await LocalStorage.setItem("ordinary", "retained");
    for (const key of keys) await LocalStorage.setItem(key, {value: key});
    for (const key of keys) assert.deepEqual(await LocalStorage.getItem(key), {value: key});
    const items = await LocalStorage.allItems();
    for (const key of keys) assert.equal(Object.hasOwn(items, key), true);
    assert.equal(await LocalStorage.getItem("ordinary"), "retained");
    const ordinary = new Cache({namespace: "ordinary"});
    ordinary.set("retained", "ordinary-cache");
    for (const namespace of keys) {
      const cache = new Cache({namespace});
      assert.equal(cache.isEmpty, true);
      for (const key of keys) {
        assert.equal(cache.get(key), undefined);
        assert.equal(cache.has(key), false);
        assert.equal(cache.remove(key), false);
      }
      cache.set("ordinary", namespace);
      for (const key of keys) cache.set(key, namespace + ":" + key);
    }
    for (const namespace of keys) {
      const cache = new Cache({namespace});
      assert.equal(cache.get("ordinary"), namespace);
      for (const key of keys) {
        assert.equal(cache.get(key), namespace + ":" + key);
        assert.equal(cache.has(key), true);
      }
    }
    assert.equal(ordinary.get("retained"), "ordinary-cache");
    const cleared = new Cache({namespace: "__proto__"});
    assert.equal(cleared.remove("constructor"), true);
    assert.equal(cleared.remove("constructor"), false);
    cleared.clear();
    assert.equal(cleared.isEmpty, true);
    assert.equal(new Cache({namespace: "constructor"}).get("toString"), "constructor:toString");
    for (const key of keys) {
      await LocalStorage.removeItem(key);
      assert.equal(await LocalStorage.getItem(key), undefined);
    }
    assert.equal(await LocalStorage.getItem("ordinary"), "retained");
  `], {timeout: 15000});
  const cache = readStore(path.join(directory, "cache.json"));
  assert.ok(Object.hasOwn(cache, "__proto__"));
  assert.ok(Object.hasOwn(cache, "constructor"));
  assert.ok(Object.hasOwn(cache, "toString"));
});

test("cache recovers malformed namespaces while preserving neighboring records", async t => {
  const directory = await fixture(t);
  await fs.writeFile(path.join(directory, "cache.json"), JSON.stringify({scalar: 42, array: ["invalid"], nil: null, ordinary: {retained: "value"}}));
  await run(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import {Cache} from ${JSON.stringify(apiModule)};
    globalThis.__superSpace = {environment: {supportPath: ${JSON.stringify(directory)}}};
    for (const namespace of ["scalar", "array", "nil"]) {
      const cache = new Cache({namespace});
      assert.equal(cache.isEmpty, true);
      assert.equal(cache.get("missing"), undefined);
      cache.set("saved", namespace);
      assert.equal(new Cache({namespace}).get("saved"), namespace);
    }
    assert.equal(new Cache({namespace: "ordinary"}).get("retained"), "value");
  `], {timeout: 15000});
  assert.deepEqual(readStore(path.join(directory, "cache.json")), {scalar: {saved: "scalar"}, array: {saved: "array"}, nil: {saved: "nil"}, ordinary: {retained: "value"}});
});
