import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { chromiumFlags } from "./browser-config.ts";

import {hasErrorCode, isRecord} from "./adapter-utils.ts";
import {buildBrowser} from "./build-browser.ts";

interface NativeHost {name: string; description: string; path: string; type: string; allowed_origins?: string[]; allowed_extensions?: string[]}

const runtime = path.dirname(fileURLToPath(import.meta.url));
const removing = process.argv.includes("--uninstall");
const manifest: unknown = JSON.parse(await fs.readFile(path.join(runtime, "browser-extension/manifest.json"), "utf8"));
if (!isRecord(manifest) || typeof manifest.key !== "string") throw new Error("Invalid browser extension manifest");
if (!removing && await fs.stat(path.join(runtime, "browser-extension/background.ts")).then(() => true, () => false)) await buildBrowser();
const id = [...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16)].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");
const launcher = path.join(runtime, "browser-host");
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
await fs.writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(runtime, "browser-native.ts"))} "$@"\n`, {mode:0o755});
const host: NativeHost = {name:"com.superspace.bridge", description:"Super Space browser connection", path:launcher, type:"stdio", allowed_origins:[`chrome-extension://${id}/`]};
const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const locations = ["chromium", "google-chrome", "google-chrome-beta", "BraveSoftware/Brave-Browser", "microsoft-edge", "vivaldi"].map(browser => path.join(config, browser, "NativeMessagingHosts"));
const legacyHostName = "com.commandspace.bridge";
const legacyFirefoxId = "command-space@commandspace.app";
async function register(directory: string, definition: NativeHost): Promise<void> {
  for (const name of [definition.name, legacyHostName]) {
    const file = path.join(directory, `${name}.json`);
    let existing: unknown;
    try { existing = JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) { if (!hasErrorCode(error, "ENOENT")) throw error; }
    if (removing) {
      if (isRecord(existing) && existing.path === launcher) await fs.unlink(file);
    } else if (name === definition.name || existing) {
      await fs.mkdir(directory, {recursive:true});
      await fs.writeFile(file, JSON.stringify({...definition, name}, null, 2));
    }
  }
}
for (const directory of locations) await register(directory, host);
const firefoxHost: NativeHost = {...host, allowed_extensions:["super-space@superspace.app", legacyFirefoxId]};
delete firefoxHost.allowed_origins;
await register(path.join(os.homedir(), ".mozilla/native-messaging-hosts"), firefoxHost);
const flags = path.join(config, "chromium-flags.conf");
try {
  const original = await fs.readFile(flags,"utf8");
  const legacyExtension = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share"), "command-space/runtime/browser-extension");
  const migrated = chromiumFlags(original, legacyExtension, false);
  const updated = chromiumFlags(migrated, path.join(runtime,"browser-extension"), !removing);
  if (updated !== original) {
    const backup = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "super-space/backups/chromium-flags.conf");
    await fs.mkdir(path.dirname(backup), {recursive:true});
    try { await fs.writeFile(backup, original, {flag:"wx"}); } catch (error) { if (!hasErrorCode(error, "EEXIST")) throw error; }
    const temporary = `${flags}.super-space.tmp`;
    await fs.writeFile(temporary, updated);
    await fs.rename(temporary, flags);
  }
} catch (error) { if (!hasErrorCode(error, "ENOENT")) throw error; }
if (removing) process.exit(0);
const firefoxExtension = path.join(runtime, "browser-extension-firefox");
await fs.cp(path.join(runtime, "browser-extension"), firefoxExtension, {recursive:true});
const firefoxManifest: Record<string, unknown> = {...manifest, background:{scripts:["dist/background.js"]}, browser_specific_settings:{gecko:{id:"super-space@superspace.app", strict_min_version:"121.0", data_collection_permissions:{required:["none"]}}}};
delete firefoxManifest.key;
await fs.writeFile(path.join(firefoxExtension, "manifest.json"), JSON.stringify(firefoxManifest, null, 2));
console.log(`Browser bridge registered (${id})`);
