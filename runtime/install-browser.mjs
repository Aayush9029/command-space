import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { chromiumFlags } from "./browser-config.mjs";

const runtime = path.dirname(fileURLToPath(import.meta.url));
const removing = process.argv.includes("--uninstall");
const manifest = JSON.parse(await fs.readFile(path.join(runtime, "browser-extension/manifest.json"), "utf8"));
const id = [...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16)].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");
const launcher = path.join(runtime, "browser-host");
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
await fs.writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(runtime, "browser-native.mjs"))} "$@"\n`, {mode:0o755});
const host = {name:"com.commandspace.bridge", description:"Command Space browser connection", path:launcher, type:"stdio", allowed_origins:[`chrome-extension://${id}/`]};
const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const locations = ["chromium", "google-chrome", "google-chrome-beta", "BraveSoftware/Brave-Browser", "microsoft-edge", "vivaldi"].map(browser => path.join(config, browser, "NativeMessagingHosts"));
for (const directory of locations) {
  if (removing) {
    const file = path.join(directory, `${host.name}.json`);
    try { if (JSON.parse(await fs.readFile(file, "utf8")).path === launcher) await fs.unlink(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    continue;
  }
  await fs.mkdir(directory, {recursive:true});
  await fs.writeFile(path.join(directory, `${host.name}.json`), JSON.stringify(host, null, 2));
}
const firefoxHost = {...host, allowed_extensions:["command-space@commandspace.app"]};
delete firefoxHost.allowed_origins;
const firefox = path.join(os.homedir(), ".mozilla/native-messaging-hosts");
if (removing) {
  const file = path.join(firefox, `${host.name}.json`);
  try { if (JSON.parse(await fs.readFile(file,"utf8")).path === launcher) await fs.unlink(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
} else {
  await fs.mkdir(firefox, {recursive:true});
  await fs.writeFile(path.join(firefox, `${host.name}.json`), JSON.stringify(firefoxHost, null, 2));
}
const flags = path.join(config, "chromium-flags.conf");
try {
  const original = await fs.readFile(flags,"utf8");
  const updated = chromiumFlags(original, path.join(runtime,"browser-extension"), !removing);
  if (updated !== original) {
    const backup = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "command-space/backups/chromium-flags.conf");
    await fs.mkdir(path.dirname(backup), {recursive:true});
    try { await fs.writeFile(backup, original, {flag:"wx"}); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const temporary = `${flags}.command-space.tmp`;
    await fs.writeFile(temporary, updated);
    await fs.rename(temporary, flags);
  }
} catch (error) { if (error.code !== "ENOENT") throw error; }
if (removing) process.exit(0);
const firefoxExtension = path.join(runtime, "browser-extension-firefox");
await fs.cp(path.join(runtime, "browser-extension"), firefoxExtension, {recursive:true});
const firefoxManifest = {...manifest, background:{scripts:["background.js"]}, browser_specific_settings:{gecko:{id:"command-space@commandspace.app", strict_min_version:"121.0", data_collection_permissions:{required:["none"]}}}};
delete firefoxManifest.key;
await fs.writeFile(path.join(firefoxExtension, "manifest.json"), JSON.stringify(firefoxManifest, null, 2));
console.log(`Browser bridge registered (${id})`);
