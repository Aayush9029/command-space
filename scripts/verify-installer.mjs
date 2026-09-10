import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";

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
  for (const command of ["bash","python3","flock","rsync","dirname","install","mkdir","mv","ln","chmod","cat","sleep"]) {
    const {stdout} = await run("/bin/sh",["-c",'command -v "$1"',"installer-test",command]);
    await fs.symlink(stdout.trim(),path.join(helpers,command));
  }
  for (const command of ["npm","systemctl","systemd-run","update-desktop-database"]) {
    await fs.writeFile(path.join(helpers,command),'#!/bin/sh\nprintf "%s %s\\n" "${0##*/}" "$*" >> "$COMMAND_SPACE_TEST_CALLS"\n',{mode:0o755});
  }
  const node = path.join(fixtureHome,".local/share/mise/shims/node");
  await fs.mkdir(path.dirname(node),{recursive:true});
  await fs.symlink(process.execPath,node);
  await fs.mkdir(path.join(fixtureHome,".config/hypr"),{recursive:true});
  await fs.writeFile(path.join(fixtureHome,".config/hypr/hyprland.lua"),"");
  await fs.mkdir(path.join(fixtureHome,".config/omarchy"),{recursive:true});
  await fs.writeFile(path.join(fixtureHome,".config/omarchy/shell.json"),JSON.stringify({bar:{layout:{left:[{id:"omarchy.menu"}]}}}));
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
  await fs.writeFile(path.join(installed,"bin/command-space"),"existing executable must survive failed preflight");
  await fs.writeFile(path.join(installed,"runtime/host.mjs"),"existing runtime must survive failed preflight");
  const unchanged = await snapshot();
  const rejectsWithoutChanges = async expression => {
    await assert.rejects(run("/bin/bash",[installer,"--prebuilt"],{env:environment,timeout:10000}),expression);
    assert.deepEqual(await snapshot(),unchanged);
  };
  await fs.unlink(node);
  await rejectsWithoutChanges(/Missing required command: node/);
  await fs.writeFile(node,'#!/bin/sh\nprintf "v22.0.0\\n"\n',{mode:0o755});
  await rejectsWithoutChanges(/Node.js 24 or newer is required; found v22.0.0/);
  await fs.unlink(node);
  await fs.symlink(process.execPath,node);
  await fs.unlink(path.join(helpers,"rsync"));
  await rejectsWithoutChanges(/Missing required command: rsync/);
  console.log("Verified real prebuilt installer with restricted SSH PATH, mise-only Node discovery, native desktop/browser integration, bundled updates, and three preflight failures without modifying existing files");
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(temporary,{recursive:true,force:true});
}
