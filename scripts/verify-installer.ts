import assert from "node:assert/strict";
import {verifyBrowserArtifacts} from "./browser-artifacts.ts";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";

assert.ok(process.versions.bun,"Run this validator with Bun");
const run = promisify(execFile);
const archiveArgument = process.argv[2];
assert.ok(archiveArgument, "Supply a Linux release archive");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(),"cs-installer-"));
const fixtureHome = path.join(temporary,"home");
const helpers = path.join(temporary,"commands");
const calls = path.join(temporary,"calls.log");
const runtimeDirectory = path.join(temporary,"run");
const ipc: Record<string, unknown>[] = [];

function parseObject(contents: string, description = "JSON output must be an object"): Record<string, unknown> {
  const value: unknown = JSON.parse(contents);
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), description);
  return value as Record<string, unknown>;
}

const server = net.createServer(socket => {
  let input = "";
  socket.on("data",chunk => {input += chunk;});
  socket.on("end",() => {
    for (const line of input.trim().split("\n").filter(Boolean)) {
      ipc.push(parseObject(line, "IPC messages must be objects"));
    }
  });
});

async function snapshot() {
  const files: Record<string, {link: string} | {hash: string; mode: number}> = {};
  async function visit(relative: string): Promise<void> {
    const file = path.join(fixtureHome,relative);
    const status = await fs.lstat(file).catch((error: unknown) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    });
    if (!status) return;
    if (status.isDirectory()) {
      for (const child of (await fs.readdir(file)).sort()) await visit(path.join(relative,child));
    } else files[relative] = status.isSymbolicLink() ? {link:await fs.readlink(file)} : {hash:createHash("sha256").update(await fs.readFile(file)).digest("hex"),mode:status.mode};
  }
  for (const location of [".local/share/super-space",".local/state/super-space",".local/share/command-space",".local/state/command-space",".local/share/applications",".local/bin",".config",".mozilla"]) await visit(location);
  return files;
}

try {
  await fs.mkdir(helpers);
  await fs.mkdir(runtimeDirectory);
  for (const command of ["bash","python3","flock","rsync","dirname","install","mkdir","mv","ln","chmod","cat","sleep","mktemp","rm"]) {
    const {stdout} = await run("/bin/sh",["-c",'command -v "$1"',"installer-test",command]);
    await fs.symlink(stdout.trim(),path.join(helpers,command));
  }
  for (const command of ["systemctl","systemd-run","update-desktop-database"]) {
    await fs.writeFile(path.join(helpers,command),'#!/bin/sh\nprintf "%s %s\\n" "${0##*/}" "$*" >> "$SUPER_SPACE_TEST_CALLS"\n',{mode:0o755});
  }
  await fs.appendFile(path.join(helpers,"systemctl"),'if [ "$2" = restart ] && [ "$3" = super-space.service ] && [ -n "$SUPER_SPACE_FAIL_RESTART" ] && [ -f "$SUPER_SPACE_FAIL_RESTART" ]; then rm "$SUPER_SPACE_FAIL_RESTART"; exit 1; fi\n');
  const bun = path.join(fixtureHome,".bun/bin/bun");
  await fs.mkdir(path.dirname(bun),{recursive:true});
  await fs.symlink(process.execPath,bun);
  await fs.mkdir(path.join(fixtureHome,".config/hypr"),{recursive:true});
  const originalHypr = 'require("hypr.bindings")\no.bind("SUPER + T", "Terminal", "terminal")\n';
  await fs.writeFile(path.join(fixtureHome,".config/hypr/hyprland.lua"),originalHypr);
  await fs.mkdir(path.join(fixtureHome,".config/omarchy"),{recursive:true});
  const originalShell = {bar:{layout:{left:[{id:"omarchy.menu",label:"Launcher"},{id:"custom.workspaces",settings:{spacing:7}}],center:[{id:"custom.clock"}],right:[{id:"omarchy.menu",monitor:"secondary"},{id:"custom.battery"}]},height:32},custom:{enabled:true}};
  const originalShellText = JSON.stringify(originalShell);
  await fs.writeFile(path.join(fixtureHome,".config/omarchy/shell.json"),originalShellText);
  const omarchy = path.join(temporary,"omarchy");
  await fs.mkdir(path.join(omarchy,"default/omarchy"),{recursive:true});
  await fs.writeFile(path.join(omarchy,"default/omarchy/omarchy-menu.jsonc"),"{}");
  const environment = {...process.env,HOME:fixtureHome,PATH:helpers,XDG_CONFIG_HOME:path.join(fixtureHome,".config"),XDG_DATA_HOME:path.join(fixtureHome,".local/share"),XDG_STATE_HOME:path.join(fixtureHome,".local/state"),XDG_RUNTIME_DIR:runtimeDirectory,OMARCHY_PATH:omarchy,SUPER_SPACE_TEST_CALLS:calls};
  await run("python3",[fileURLToPath(new URL("../runtime/unpack-release.py",import.meta.url)),path.resolve(archiveArgument),temporary]);
  const bundle = path.join(temporary,"super-space");
  await verifyBrowserArtifacts(path.join(bundle, "runtime/browser-extension"), "chromium");
  const installer = path.join(bundle,"scripts/install-linux.sh");
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path.join(runtimeDirectory,"super-space.sock"), resolve);
  });
  await run("/bin/bash",[installer,"--prebuilt"],{env:environment,timeout:30000});
  const installed = path.join(fixtureHome,".local/share/super-space");
  assert.deepEqual(await fs.readFile(path.join(installed,"bin/super-space")),await fs.readFile(path.join(bundle,"bin/super-space")));
  assert.ok(ipc.some(message => message.command === "ping"),"The real executable must reach the isolated IPC socket");
  assert.match(await fs.readFile(path.join(fixtureHome,".config/hypr/hyprland.lua"),"utf8"),/require\("hypr.super-space"\)/);
  const browser = parseObject(await fs.readFile(path.join(fixtureHome,".config/chromium/NativeMessagingHosts/com.superspace.bridge.json"),"utf8"));
  assert.equal(browser.path,path.join(installed,"runtime/browser-host"));
  for (const extension of await fs.readdir(path.join(bundle,"extensions"))) {
    assert.equal(await fs.readFile(path.join(installed,"extensions",extension,".super-space-source"),"utf8"),path.join(installed,"bundled-extensions",extension));
  }
  assert.match(await fs.readFile(calls,"utf8"),/systemctl --user restart super-space.service/);
  const expectedShell = structuredClone(originalShell);
  expectedShell.bar.layout.left[0].id = "super-space.launcher";
  expectedShell.bar.layout.right[0].id = "super-space.launcher";
  const verifyDesktop = async () => {
    await verifyBrowserArtifacts(path.join(installed, "runtime/browser-extension"), "chromium");
    await verifyBrowserArtifacts(path.join(installed, "runtime/browser-extension-firefox"), "firefox");
    const main = await fs.readFile(path.join(fixtureHome,".config/hypr/hyprland.lua"),"utf8");
    assert.ok(main.startsWith(originalHypr),"User Hyprland configuration must survive installation");
    assert.equal(main.split('require("hypr.super-space")').length - 1,1,"Repeated installs must not duplicate the binding include");
    const bindings = await fs.readFile(path.join(fixtureHome,".config/hypr/super-space.lua"),"utf8");
    assert.match(bindings,/hl\.unbind\("SUPER \+ SPACE"\); o\.bind\("SUPER \+ SPACE", "Super Space",/);
    assert.ok(bindings.includes(`${fixtureHome}/.local/bin/super-space' toggle`),"Super+Space must launch the installed application");
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(fixtureHome,".config/omarchy/shell.json"),"utf8")),expectedShell,"Replace launcher widgets while retaining other modules and settings");
    assert.equal(await fs.readFile(path.join(fixtureHome,".local/state/super-space/backups/hyprland.lua"),"utf8"),originalHypr);
    assert.equal(await fs.readFile(path.join(fixtureHome,".local/state/super-space/backups/shell.json"),"utf8"),originalShellText);
    const widget = path.join(fixtureHome,".config/omarchy/plugins/super-space.launcher");
    assert.ok((await fs.readFile(path.join(widget,"BarWidget.qml"),"utf8")).includes("super-space"));
    assert.equal(parseObject(await fs.readFile(path.join(widget,"manifest.json"),"utf8")).id,"super-space.launcher");
  };
  await verifyDesktop();
  const userFiles = new Map([
    [".config/super-space/config.toml",'show_icons = false\n'],
    [".local/share/super-space/extensions/user-extension/source.ts",'export const custom = true;\n'],
    [".local/share/super-space/extension-data/developer-tools/storage.json",'{"keep":"my data"}'],
    [".local/state/super-space/user-history.json",'["kept"]'],
  ]);
  for (const [relative,content] of userFiles) {
    const destination = path.join(fixtureHome,relative);
    await fs.mkdir(path.dirname(destination),{recursive:true});
    await fs.writeFile(destination,content);
  }
  await run("/bin/bash",[installer,"--prebuilt"],{env:environment,timeout:30000});
  await verifyDesktop();
  for (const [relative,content] of userFiles) assert.equal(await fs.readFile(path.join(fixtureHome,relative),"utf8"),content,`Repeated installation must preserve ${relative}`);

  const rejectsWithRollback = async (expression: RegExp, overrides: NodeJS.ProcessEnv = {}) => {
    const before = await snapshot();
    await assert.rejects(run("/bin/bash",[installer,"--prebuilt"],{env:{...environment,...overrides},timeout:30000}),expression);
    assert.deepEqual(await snapshot(),before,"Failed installation must restore all existing managed files and preserve user data");
    assert.match(await fs.readFile(calls,"utf8"),/systemctl --user restart super-space.service/);
  };
  const shell = path.join(fixtureHome,".config/omarchy/shell.json");
  const workingShell = await fs.readFile(shell);
  await fs.writeFile(shell,"invalid JSON");
  await rejectsWithRollback(/Restoring the previous installation/);
  await fs.writeFile(shell,workingShell);
  const browserScript = path.join(bundle,"runtime/install-browser.ts");
  const workingBrowserScript = await fs.readFile(browserScript);
  await fs.writeFile(browserScript,'throw new Error("fixture browser failure");');
  await rejectsWithRollback(/fixture browser failure/);
  await fs.writeFile(browserScript,workingBrowserScript);
  const [bundledExtension] = await fs.readdir(path.join(bundle,"extensions"));
  assert.ok(bundledExtension, "The package must contain a bundled extension");
  const invalidSource = path.join(bundle,"extensions",bundledExtension,"invalid-symlink");
  await fs.symlink("package.json",invalidSource);
  await rejectsWithRollback(/Extension sources must not contain symlinks/);
  await fs.unlink(invalidSource);
  const managedDesktop = path.join(fixtureHome, ".local/share/applications/super-space.desktop");
  const desktopContent = await fs.readFile(managedDesktop);
  const outsideDesktop = path.join(temporary, "outside.desktop");
  await fs.writeFile(outsideDesktop, desktopContent);
  await fs.unlink(managedDesktop);
  await fs.symlink(outsideDesktop, managedDesktop);
  await rejectsWithRollback(/Managed installation path is a symlink/);
  await fs.unlink(managedDesktop);
  await fs.writeFile(managedDesktop, desktopContent);
  const restartFailure = path.join(temporary,"fail-restart");
  await fs.writeFile(restartFailure,"");
  await rejectsWithRollback(/Restoring the previous installation/,{SUPER_SPACE_FAIL_RESTART:restartFailure});
  assert.equal(await fs.stat(restartFailure).catch(() => null),null,"The injected restart failure must run exactly once so recovery can restart the previous version");
  const legacyFiles = new Map([
    [".local/share/super-space/extensions/user-extension/.super-space-source", "https://github.com/example/tools/tree/main/extension"],
    [".local/share/super-space/extensions/local-extension/.super-space-source", path.join(fixtureHome, "Developer/super-space/scripts/fixtures/native-validation")],
    [".local/share/super-space/extension-data/user-extension/oauth/tokens.json", '{"access_token":"fixture-private-token"}'],
    [".local/state/super-space/ranking.db", "fixture ranking database bytes"],
    [".local/state/super-space/files.db", "fixture file index bytes"],
  ]);
  for (const [relative, content] of legacyFiles) {
    const file = path.join(fixtureHome, relative);
    await fs.mkdir(path.dirname(file), {recursive:true});
    await fs.writeFile(file, content);
  }
  for (const prefix of [".config", ".local/share", ".local/state"]) {
    await fs.rename(path.join(fixtureHome, prefix, "super-space"), path.join(fixtureHome, prefix, "command-space"));
  }
  await fs.mkdir(path.join(fixtureHome, ".cache/command-space"), {recursive:true});
  await fs.writeFile(path.join(fixtureHome, ".cache/command-space/old-index"), "obsolete cache");
  const legacyRoot = path.join(fixtureHome, ".local/share/command-space");
  await fs.rename(path.join(legacyRoot, "bin/super-space"), path.join(legacyRoot, "bin/command-space"));
  for (const extension of await fs.readdir(path.join(legacyRoot, "extensions"))) {
    const marker = path.join(legacyRoot, "extensions", extension, ".super-space-source");
    const source = await fs.readFile(marker, "utf8");
    await fs.writeFile(path.join(path.dirname(marker), ".command-space-source"), source.replaceAll("/super-space/", "/command-space/"));
    await fs.unlink(marker);
  }
  const managed = [".local/bin/super-space-menu", ".config/systemd/user/super-space.service", ".local/share/applications/super-space.desktop", ".config/hypr/super-space.lua"];
  for (const relative of managed) {
    const source = path.join(fixtureHome, relative);
    const destination = path.join(fixtureHome, relative.replaceAll("super-space", "command-space"));
    await fs.writeFile(destination, (await fs.readFile(source, "utf8")).replaceAll("super-space", "command-space"));
    await fs.unlink(source);
  }
  await fs.unlink(path.join(fixtureHome, ".local/bin/super-space"));
  await fs.symlink(path.join(legacyRoot, "bin/command-space"), path.join(fixtureHome, ".local/bin/command-space"));
  await fs.rename(path.join(fixtureHome, ".config/omarchy/plugins/super-space.launcher"), path.join(fixtureHome, ".config/omarchy/plugins/command-space.launcher"));
  for (const relative of [".config/hypr/hyprland.lua", ".config/omarchy/shell.json"]) {
    const file = path.join(fixtureHome, relative);
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replaceAll("super-space", "command-space"));
  }
  const oldHost = path.join(fixtureHome, ".config/chromium/NativeMessagingHosts/com.commandspace.bridge.json");
  await fs.writeFile(oldHost, JSON.stringify({name:"com.commandspace.bridge",path:path.join(legacyRoot,"runtime/browser-host")}));
  const flagsPath = path.join(fixtureHome, ".config/chromium-flags.conf");
  await fs.writeFile(flagsPath, `--custom-user-flag\n--load-extension=/custom/extension,${legacyRoot}/runtime/browser-extension\n`);
  await fs.mkdir(path.join(fixtureHome, ".config/super-space"));
  await fs.writeFile(path.join(fixtureHome, ".config/super-space/config.toml"), "conflicting new configuration");
  await rejectsWithRollback(/Both launcher directories contain data/);
  await fs.rm(path.join(fixtureHome, ".config/super-space"), {recursive:true});
  await fs.writeFile(restartFailure, "");
  await rejectsWithRollback(/Restoring the previous installation/, {SUPER_SPACE_FAIL_RESTART:restartFailure});
  assert.match(await fs.readFile(calls, "utf8"), /systemctl --user restart command-space.service/);
  await run("/bin/bash", [installer, "--prebuilt"], {env:environment, timeout:30000});
  await verifyDesktop();
  for (const [relative, content] of [...userFiles, ...legacyFiles]) {
    assert.equal(await fs.readFile(path.join(fixtureHome, relative), "utf8"), content, `Migration must preserve ${relative}`);
  }
  for (const prefix of [".config", ".local/share", ".local/state"]) {
    assert.equal(await fs.stat(path.join(fixtureHome, prefix, "command-space")).catch(() => null), null);
  }
  for (const relative of [...managed, ".local/bin/super-space", ".config/omarchy/plugins/super-space.launcher"]) {
    assert.equal(await fs.lstat(path.join(fixtureHome, relative.replaceAll("super-space", "command-space"))).catch(() => null), null, `Legacy managed artifact must be removed: ${relative}`);
  }
  for (const extension of await fs.readdir(path.join(bundle,"extensions"))) {
    assert.equal(await fs.readFile(path.join(installed,"extensions",extension,".super-space-source"),"utf8"),path.join(installed,"bundled-extensions",extension));
  }
  assert.equal(await fs.stat(path.join(fixtureHome, ".cache/command-space")).catch(() => null), null);
  assert.equal(await fs.stat(path.join(installed, "bin/command-space")).catch(() => null), null);
  const flags = await fs.readFile(flagsPath, "utf8");
  assert.ok(flags.includes("--custom-user-flag") && flags.includes("/custom/extension"));
  assert.ok(flags.includes(`${installed}/runtime/browser-extension`) && !flags.includes(`${legacyRoot}/runtime/browser-extension`));
  assert.equal(parseObject(await fs.readFile(oldHost, "utf8")).path, path.join(installed, "runtime/browser-host"));
  await rejectsWithRollback(/XDG_DATA_HOME must use/,{XDG_DATA_HOME:path.join(fixtureHome,"custom-data")});
  await fs.writeFile(path.join(installed,"bin/super-space"),"existing executable must survive failed preflight");
  await fs.writeFile(path.join(installed,"runtime/host.ts"),"existing runtime must survive failed preflight");
  const unchanged = await snapshot();
  const rejectsWithoutChanges = async (expression: RegExp) => {
    await assert.rejects(run("/bin/bash",[installer,"--prebuilt"],{env:environment,timeout:10000}),expression);
    assert.deepEqual(await snapshot(),unchanged);
  };
  for (const name of ["transaction.py", "desktop-entry.py", "super-space-menu", "super-space.service", "super-space.desktop.in"]) {
    const file = path.join(bundle, "scripts/installer", name);
    await fs.rename(file, `${file}.missing`);
    try {
      await rejectsWithoutChanges(/The package is incomplete: missing scripts\/installer\//);
    } finally {
      await fs.rename(`${file}.missing`, file);
    }
  }
  await fs.unlink(bun);
  await rejectsWithoutChanges(/Missing required command: bun/);
  await fs.writeFile(bun,'#!/bin/sh\nprintf "1.3.0\\n"\n',{mode:0o755});
  await rejectsWithoutChanges(/Bun 1.4.2 or newer is required; found 1.3.0/);
  await fs.unlink(bun);
  await fs.symlink(process.execPath,bun);
  await fs.unlink(path.join(helpers,"rsync"));
  await rejectsWithoutChanges(/Missing required command: rsync/);
  console.log("Verified real prebuilt installer with restricted SSH PATH, Bun home discovery, shortcut/bar replacement, original backups, repeated install data preservation, native browser integration, bundled updates, transactional rollback including legacy migration, legacy data and source marker preservation, conflict rejection, unsupported XDG rejection, and missing helper and dependency failures without modifying existing files");
} finally {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await fs.rm(temporary,{recursive:true,force:true});
}
