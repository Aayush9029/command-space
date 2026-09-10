import assert from "node:assert/strict";
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
const temporary = await fs.mkdtemp(path.join(os.tmpdir(),"cs-installer-"));
const fixtureHome = path.join(temporary,"home");
const helpers = path.join(temporary,"commands");
const calls = path.join(temporary,"calls.log");
const runtimeDirectory = path.join(temporary,"run");
const ipc = [];
const server = net.createServer(socket => {
  let input = "";
  socket.on("data",chunk => {input += chunk;});
  socket.on("end",() => {for (const line of input.trim().split("\n").filter(Boolean)) ipc.push(JSON.parse(line));});
});

async function snapshot() {
  const files = {};
  async function visit(relative) {
    const file = path.join(fixtureHome,relative);
    const status = await fs.lstat(file).catch(error => {if (error.code !== "ENOENT") throw error;});
    if (!status) return;
    if (status.isDirectory()) {
      for (const child of (await fs.readdir(file)).sort()) await visit(path.join(relative,child));
    } else files[relative] = status.isSymbolicLink() ? {link:await fs.readlink(file)} : {hash:createHash("sha256").update(await fs.readFile(file)).digest("hex"),mode:status.mode};
  }
  for (const location of [".local/share/command-space",".local/state/command-space",".local/bin",".config",".mozilla"]) await visit(location);
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
    await fs.writeFile(path.join(helpers,command),'#!/bin/sh\nprintf "%s %s\\n" "${0##*/}" "$*" >> "$COMMAND_SPACE_TEST_CALLS"\n',{mode:0o755});
  }
  await fs.appendFile(path.join(helpers,"systemctl"),'if [ "$2" = restart ] && [ "$3" = command-space.service ] && [ -n "$COMMAND_SPACE_FAIL_RESTART" ] && [ -f "$COMMAND_SPACE_FAIL_RESTART" ]; then rm "$COMMAND_SPACE_FAIL_RESTART"; exit 1; fi\n');
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
  const environment = {...process.env,HOME:fixtureHome,PATH:helpers,XDG_CONFIG_HOME:path.join(fixtureHome,".config"),XDG_DATA_HOME:path.join(fixtureHome,".local/share"),XDG_STATE_HOME:path.join(fixtureHome,".local/state"),XDG_RUNTIME_DIR:runtimeDirectory,OMARCHY_PATH:omarchy,COMMAND_SPACE_TEST_CALLS:calls};
  await run("python3",[fileURLToPath(new URL("../runtime/unpack-release.py",import.meta.url)),path.resolve(process.argv[2]),temporary]);
  const bundle = path.join(temporary,"command-space");
  const installer = path.join(bundle,"scripts/install-linux.sh");
  await new Promise(resolve => server.listen(path.join(runtimeDirectory,"command-space.sock"),resolve));
  await run("/bin/bash",[installer,"--prebuilt"],{env:environment,timeout:30000});
  const installed = path.join(fixtureHome,".local/share/command-space");
  assert.deepEqual(await fs.readFile(path.join(installed,"bin/command-space")),await fs.readFile(path.join(bundle,"bin/command-space")));
  assert.ok(ipc.some(message => message.command === "ping"),"The real executable must reach the isolated IPC socket");
  assert.match(await fs.readFile(path.join(fixtureHome,".config/hypr/hyprland.lua"),"utf8"),/require\("hypr.command-space"\)/);
  const browser = JSON.parse(await fs.readFile(path.join(fixtureHome,".config/chromium/NativeMessagingHosts/com.commandspace.bridge.json"),"utf8"));
  assert.equal(browser.path,path.join(installed,"runtime/browser-host"));
  for (const extension of await fs.readdir(path.join(bundle,"extensions"))) {
    assert.equal(await fs.readFile(path.join(installed,"extensions",extension,".command-space-source"),"utf8"),path.join(installed,"bundled-extensions",extension));
  }
  assert.match(await fs.readFile(calls,"utf8"),/systemctl --user restart command-space.service/);
  const expectedShell = structuredClone(originalShell);
  expectedShell.bar.layout.left[0].id = "command-space.launcher";
  expectedShell.bar.layout.right[0].id = "command-space.launcher";
  const verifyDesktop = async () => {
    const main = await fs.readFile(path.join(fixtureHome,".config/hypr/hyprland.lua"),"utf8");
    assert.ok(main.startsWith(originalHypr),"User Hyprland configuration must survive installation");
    assert.equal(main.split('require("hypr.command-space")').length - 1,1,"Repeated installs must not duplicate the binding include");
    const bindings = await fs.readFile(path.join(fixtureHome,".config/hypr/command-space.lua"),"utf8");
    assert.match(bindings,/hl\.unbind\("SUPER \+ SPACE"\); o\.bind\("SUPER \+ SPACE", "Command Space",/);
    assert.ok(bindings.includes(`${fixtureHome}/.local/bin/command-space' toggle`),"Super+Space must launch the installed application");
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(fixtureHome,".config/omarchy/shell.json"),"utf8")),expectedShell,"Replace launcher widgets while retaining other modules and settings");
    assert.equal(await fs.readFile(path.join(fixtureHome,".local/state/command-space/backups/hyprland.lua"),"utf8"),originalHypr);
    assert.equal(await fs.readFile(path.join(fixtureHome,".local/state/command-space/backups/shell.json"),"utf8"),originalShellText);
    const widget = path.join(fixtureHome,".config/omarchy/plugins/command-space.launcher");
    assert.ok((await fs.readFile(path.join(widget,"BarWidget.qml"),"utf8")).includes("command-space"));
    assert.equal(JSON.parse(await fs.readFile(path.join(widget,"manifest.json"),"utf8")).id,"command-space.launcher");
  };
  await verifyDesktop();
  const userFiles = new Map([
    [".config/command-space/config.toml",'show_icons = false\n'],
    [".local/share/command-space/extensions/user-extension/source.ts",'export const custom = true;\n'],
    [".local/share/command-space/extension-data/developer-tools/storage.json",'{"keep":"my data"}'],
    [".local/state/command-space/user-history.json",'["kept"]'],
  ]);
  for (const [relative,content] of userFiles) {
    const destination = path.join(fixtureHome,relative);
    await fs.mkdir(path.dirname(destination),{recursive:true});
    await fs.writeFile(destination,content);
  }
  await run("/bin/bash",[installer,"--prebuilt"],{env:environment,timeout:30000});
  await verifyDesktop();
  for (const [relative,content] of userFiles) assert.equal(await fs.readFile(path.join(fixtureHome,relative),"utf8"),content,`Repeated installation must preserve ${relative}`);

  const rejectsWithRollback = async (expression,overrides = {}) => {
    const before = await snapshot();
    await assert.rejects(run("/bin/bash",[installer,"--prebuilt"],{env:{...environment,...overrides},timeout:30000}),expression);
    assert.deepEqual(await snapshot(),before,"Failed installation must restore all existing managed files and preserve user data");
    assert.match(await fs.readFile(calls,"utf8"),/systemctl --user restart command-space.service/);
  };
  const shell = path.join(fixtureHome,".config/omarchy/shell.json");
  const workingShell = await fs.readFile(shell);
  await fs.writeFile(shell,"invalid JSON");
  await rejectsWithRollback(/Restoring the previous installation/);
  await fs.writeFile(shell,workingShell);
  const browserScript = path.join(bundle,"runtime/install-browser.mjs");
  const workingBrowserScript = await fs.readFile(browserScript);
  await fs.writeFile(browserScript,'throw new Error("fixture browser failure");');
  await rejectsWithRollback(/fixture browser failure/);
  await fs.writeFile(browserScript,workingBrowserScript);
  const [bundledExtension] = await fs.readdir(path.join(bundle,"extensions"));
  const invalidSource = path.join(bundle,"extensions",bundledExtension,"invalid-symlink");
  await fs.symlink("package.json",invalidSource);
  await rejectsWithRollback(/Extension sources must not contain symlinks/);
  await fs.unlink(invalidSource);
  const restartFailure = path.join(temporary,"fail-restart");
  await fs.writeFile(restartFailure,"");
  await rejectsWithRollback(/Restoring the previous installation/,{COMMAND_SPACE_FAIL_RESTART:restartFailure});
  assert.equal(await fs.stat(restartFailure).catch(() => null),null,"The injected restart failure must run exactly once so recovery can restart the previous version");
  await rejectsWithRollback(/XDG_DATA_HOME must use/,{XDG_DATA_HOME:path.join(fixtureHome,"custom-data")});
  await fs.writeFile(path.join(installed,"bin/command-space"),"existing executable must survive failed preflight");
  await fs.writeFile(path.join(installed,"runtime/host.mjs"),"existing runtime must survive failed preflight");
  const unchanged = await snapshot();
  const rejectsWithoutChanges = async expression => {
    await assert.rejects(run("/bin/bash",[installer,"--prebuilt"],{env:environment,timeout:10000}),expression);
    assert.deepEqual(await snapshot(),unchanged);
  };
  await fs.unlink(bun);
  await rejectsWithoutChanges(/Missing required command: bun/);
  await fs.writeFile(bun,'#!/bin/sh\nprintf "1.3.0\\n"\n',{mode:0o755});
  await rejectsWithoutChanges(/Bun 1.4.2 or newer is required; found 1.3.0/);
  await fs.unlink(bun);
  await fs.symlink(process.execPath,bun);
  await fs.unlink(path.join(helpers,"rsync"));
  await rejectsWithoutChanges(/Missing required command: rsync/);
  console.log("Verified real prebuilt installer with restricted SSH PATH, Bun home discovery, shortcut/bar replacement, original backups, repeated install data preservation, native browser integration, bundled updates, four transactional rollback cases, unsupported XDG rejection, and three preflight failures without modifying existing files");
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(temporary,{recursive:true,force:true});
}
