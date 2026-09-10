import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {fileURLToPath, pathToFileURL} from "node:url";
import {execFile, spawn} from "node:child_process";
import {once} from "node:events";
import readline from "node:readline";
import {promisify} from "node:util";

assert.ok(process.versions.bun,"Run this validator with Bun");
const run = promisify(execFile);
const archive = path.resolve(process.argv[2]);
const name = path.basename(archive);
const match = /^command-space-(\d+\.\d+\.\d+)-linux-(aarch64|x86_64)\.tar\.gz$/.exec(name);
assert.ok(match,"Package filename must contain its release version and architecture");
const [,version,architecture] = match;
assert.equal(architecture,{arm64:"aarch64",x64:"x86_64"}[process.arch],"Package validation must run on its native architecture");
const bytes = await fs.readFile(archive);
const checksum = await fs.readFile(`${archive}.sha256`,"utf8");
assert.equal(checksum.trim(),`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
const directory = await fs.mkdtemp(path.join(os.tmpdir(),"command-space-package-"));

async function verifyExtensionHost(bundle) {
  const extension = path.join(directory,"package-validation");
  await fs.mkdir(path.join(extension,"src"),{recursive:true});
  await fs.writeFile(path.join(extension,"package.json"),JSON.stringify({name:"package-validation",commands:[{name:"verify",title:"Verify package",mode:"no-view"}]}));
  await fs.writeFile(path.join(extension,"src/verify.ts"),'import {LocalStorage} from "@raycast/api"; export default async function Verify() { await LocalStorage.setItem("result","packaged TypeScript host works"); }');
  const data = path.join(directory,"data");
  const child = spawn(process.execPath,[path.join(bundle,"runtime/host.mjs")],{env:{...process.env,XDG_DATA_HOME:data},stdio:["pipe","pipe","pipe"]});
  const closed = once(child,"close");
  const lines = readline.createInterface({input:child.stdout});
  let diagnostic = "", timeout;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data",value => { diagnostic = (diagnostic + value).slice(-4096); });
  try {
    await new Promise((resolve,reject) => {
      timeout = setTimeout(() => reject(new Error(`Packaged extension host timed out: ${diagnostic}`)),10000);
      child.once("error",reject);
      child.once("exit",code => reject(new Error(`Packaged extension host exited ${code}: ${diagnostic}`)));
      lines.on("line",line => {
        try {
          const message = JSON.parse(line);
          if (message.type === "error") reject(new Error(message.message));
          if (message.type === "done") resolve();
        } catch (error) { reject(error); }
      });
      child.stdin.write(`${JSON.stringify({type:"launch",extension,command:"verify"})}\n`);
    });
    const stored = JSON.parse(await fs.readFile(path.join(data,"command-space/extension-data/package-validation/storage.json"),"utf8"));
    assert.equal(stored.result,"packaged TypeScript host works");
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"),3000);
    await closed;
    clearTimeout(force);
  }
}

try {
  await run("python3",[fileURLToPath(new URL("../runtime/unpack-release.py",import.meta.url)),archive,directory],{timeout:30000});
  const bundle = path.join(directory,"command-space");
  const binary = path.join(bundle,"bin/command-space");
  const {stdout} = await run(binary,["--version"],{timeout:10000});
  assert.equal(stdout.trim(),`Command Space ${version}`);
  for (const file of ["scripts/install.sh","scripts/install-linux.sh","scripts/start-daemon.sh","runtime/host.mjs","runtime/bun.lock","runtime/invocation.mjs","runtime/storage.mjs","runtime/updater.mjs","runtime/unpack-release.py","runtime/icon-catalog.mjs","runtime/icons/catalog.json","runtime/icons/LICENSE","README.md","LICENSE.md","docs/DEVELOPMENT.md","docs/PORTING.md","docs/assets/banner.png"]) await fs.access(path.join(bundle,file));
  await run("bash",["-n",path.join(bundle,"scripts/install-linux.sh")]);
  await run("bash",["-n",path.join(bundle,"scripts/start-daemon.sh")]);
  const runtimeManifest = JSON.parse(await fs.readFile(path.join(bundle,"runtime/package.json"),"utf8"));
  const legacyLock = JSON.parse(await fs.readFile(path.join(bundle,"runtime/package-lock.json"),"utf8"));
  assert.equal(legacyLock.lockfileVersion,3,"The 1.0.1 updater compatibility artifact must remain a valid lockfile");
  assert.deepEqual(legacyLock.packages[""].dependencies,runtimeManifest.dependencies,"The updater compatibility artifact must match the bundled dependency versions");
  for (const [dependency,version] of Object.entries(runtimeManifest.dependencies)) {
    assert.equal(legacyLock.packages[`node_modules/${dependency}`].version,version);
    const installed = JSON.parse(await fs.readFile(path.join(bundle,"runtime/node_modules",dependency,"package.json"),"utf8"));
    assert.equal(installed.version,version,"Packaged dependencies must match the frozen Bun installation");
  }
  const require = createRequire(path.join(bundle,"runtime/package.json"));
  const esbuild = require("esbuild");
  assert.equal(typeof require("react").createElement,"function");
  assert.equal(typeof require("react-reconciler"),"function");
  const {iconCatalog} = await import(pathToFileURL(path.join(bundle,"runtime/icon-catalog.mjs")));
  const icons = new Set(Object.values(iconCatalog));
  assert.ok(icons.size > 0,"The package must include its icon catalog");
  for (const icon of icons) await fs.access(icon);
  let commands = 0;
  for (const entry of await fs.readdir(path.join(bundle,"extensions"),{withFileTypes:true})) {
    if (!entry.isDirectory()) continue;
    const source = path.join(bundle,"extensions",entry.name);
    const manifest = JSON.parse(await fs.readFile(path.join(source,"package.json"),"utf8"));
    assert.equal(manifest.name,entry.name,"Bundled extension IDs must match their directories");
    for (const command of manifest.commands) {
      let entryPoint;
      for (const suffix of ["tsx","ts","jsx","js"]) {
        const candidate = path.join(source,"src",`${command.name}.${suffix}`);
        if (await fs.stat(candidate).then(status => status.isFile(),() => false)) { entryPoint = candidate; break; }
      }
      assert.ok(entryPoint,`Missing bundled command ${manifest.name}/${command.name}`);
      await esbuild.build({entryPoints:[entryPoint],bundle:true,write:false,platform:"node",format:"esm",packages:"external",logLevel:"silent"});
      commands++;
    }
  }
  assert.ok(commands > 0,"The package must include its bundled commands");
  await verifyExtensionHost(bundle);
  console.log(`Verified Linux ${architecture} package, native TypeScript host, ${commands} bundled commands, and ${icons.size} icon assets`);
} finally {
  await fs.rm(directory,{recursive:true,force:true});
}
