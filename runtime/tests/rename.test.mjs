import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {lookupCredential, clearCredential} from "../oauth.mjs";

const run = promisify(execFile);
const runtime = fileURLToPath(new URL("../", import.meta.url));

function credentials(attributes, entries, failStore = false) {
  const secrets = new Map(entries.map(([application, value]) => [JSON.stringify(["application", application, ...attributes]), value]));
  const access = async ([operation, ...arguments_], value) => {
    const key = JSON.stringify(arguments_.filter(argument => !argument.startsWith("--label=")));
    if (operation === "lookup") return secrets.get(key);
    if (operation === "clear") secrets.delete(key);
    if (operation === "store") {
      if (failStore) throw new Error("Keyring locked");
      secrets.set(key, value);
    }
  };
  return {access, secrets};
}

for (const attributes of [["extension", "fixture", "provider", "account"], ["service", "ai", "endpoint", "https://example.invalid/api"]]) {
  test(`renamed keyring preserves ${attributes[0]} credentials and revocation`, async () => {
    const legacy = credentials(attributes, [["command-space", "saved-secret"]]);
    assert.equal(await lookupCredential(attributes, "Super Space", legacy.access), "saved-secret");
    assert.deepEqual([...legacy.secrets.values()], ["saved-secret"]);
    assert.match([...legacy.secrets.keys()][0], /super-space/);
    await clearCredential(attributes, legacy.access);
    assert.equal(await lookupCredential(attributes, "Super Space", legacy.access), undefined);
    const both = credentials(attributes, [["command-space", "old"], ["super-space", "new"]]);
    assert.equal(await lookupCredential(attributes, "Super Space", both.access), "new");
    await clearCredential(attributes, both.access);
    assert.equal(both.secrets.size, 0);
  });
}

test("a failed keyring migration retains the original secret", async () => {
  const attributes = ["extension", "fixture", "provider", "account"];
  const fixture = credentials(attributes, [["command-space", "saved-secret"]], true);
  await assert.rejects(lookupCredential(attributes, "Super Space", fixture.access), /Keyring locked/);
  assert.equal(fixture.secrets.size, 1);
  assert.match([...fixture.secrets.keys()][0], /command-space/);
});

test("browser migration reconnects existing registrations and preserves other extensions", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "super-space-browser-migration-"));
  t.after(() => fs.rm(home, {recursive:true, force:true}));
  const data = path.join(home, "data");
  const target = path.join(data, "super-space/runtime");
  const config = path.join(home, "config");
  await fs.mkdir(target, {recursive:true});
  for (const file of ["install-browser.mjs", "browser-config.mjs", "browser-extension"]) {
    await fs.cp(path.join(runtime, file), path.join(target, file), {recursive:true});
  }
  const chromium = path.join(config, "chromium/NativeMessagingHosts");
  const firefox = path.join(home, ".mozilla/native-messaging-hosts");
  const legacyName = "com.commandspace.bridge";
  for (const directory of [chromium, firefox]) {
    await fs.mkdir(directory, {recursive:true});
    await fs.writeFile(path.join(directory, `${legacyName}.json`), JSON.stringify({name:legacyName, path:path.join(data, "command-space/runtime/browser-host")}));
    await fs.writeFile(path.join(directory, "unrelated.json"), "unrelated");
  }
  const oldExtension = path.join(data, "command-space/runtime/browser-extension");
  await fs.writeFile(path.join(config, "chromium-flags.conf"), `--ozone-platform=wayland\n--load-extension=/other,${oldExtension}\n`);
  const env = {...process.env, HOME:home, XDG_CONFIG_HOME:config, XDG_DATA_HOME:data, XDG_STATE_HOME:path.join(home, "state")};
  const installer = path.join(target, "install-browser.mjs");
  await run(process.execPath, [installer], {env});
  for (const directory of [chromium, firefox]) {
    for (const name of [legacyName, "com.superspace.bridge"]) {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, `${name}.json`)));
      assert.equal(manifest.name, name);
      assert.equal(manifest.path, path.join(target, "browser-host"));
      if (directory === firefox) assert.ok(manifest.allowed_extensions.includes("command-space@commandspace.app"));
    }
  }
  const manifest = JSON.parse(await fs.readFile(path.join(target, "browser-extension/manifest.json")));
  assert.equal(manifest.key, JSON.parse(await fs.readFile(path.join(runtime, "browser-extension/manifest.json"))).key);
  const flags = await fs.readFile(path.join(config, "chromium-flags.conf"), "utf8");
  assert.equal(flags, `--ozone-platform=wayland\n--load-extension=/other,${target}/browser-extension\n`);
  await run(process.execPath, [installer], {env});
  assert.equal(await fs.readFile(path.join(config, "chromium-flags.conf"), "utf8"), flags);
  await run(process.execPath, [installer, "--uninstall"], {env});
  assert.equal(await fs.readFile(path.join(config, "chromium-flags.conf"), "utf8"), "--ozone-platform=wayland\n--load-extension=/other\n");
  for (const directory of [chromium, firefox]) assert.deepEqual(await fs.readdir(directory), ["unrelated.json"]);
});
