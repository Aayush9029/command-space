import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const binary = process.argv[2] || path.join(os.homedir(), ".local/bin/command-space");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "command-space-lifecycle-"));
const source = path.join(temporary, "source");
const env = {...process.env, XDG_DATA_HOME:path.join(temporary,"data"), XDG_STATE_HOME:path.join(temporary,"state"), npm_config_registry:"http://127.0.0.1:9", npm_config_fetch_retries:"0", npm_config_fetch_timeout:"1000"};
const root = path.join(env.XDG_DATA_HOME,"command-space");
const installed = path.join(root,"extensions/lifecycle-fixture");
function run(args, success = true) {
  const result = spawnSync(binary,["extension",...args],{env,cwd:temporary,encoding:"utf8",timeout:15000});
  if (success) assert.equal(result.status,0,result.stderr);
  else assert.notEqual(result.status,0,"The invalid installation unexpectedly succeeded");
}
const manifest = {name:"lifecycle-fixture",title:"Lifecycle Fixture",commands:[{name:"main",title:"Fixture",mode:"no-view"}]};
try {
  await fs.mkdir(path.join(source,"src"),{recursive:true});
  await fs.writeFile(path.join(source,"package.json"),JSON.stringify(manifest));
  await fs.writeFile(path.join(source,"src/main.ts"),"export default function Command() { return 'first'; }");
  run(["install","source"]);
  assert.equal(await fs.readFile(path.join(installed,".command-space-source"),"utf8"),source);
  run(["install",source],false);
  await fs.writeFile(path.join(source,"src/main.ts"),"export default function Command() { return 'updated'; }");
  run(["update","lifecycle-fixture"]);
  assert.match(await fs.readFile(path.join(installed,"src/main.ts"),"utf8"),/updated/);
  await fs.writeFile(path.join(source,"package.json"),JSON.stringify({...manifest,dependencies:{"missing-fixture-package":"1.0.0"}}));
  run(["update","lifecycle-fixture"],false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(installed,"package.json"),"utf8")),manifest);
  assert.deepEqual(await fs.readdir(path.join(root,"extensions")),["lifecycle-fixture"]);
  await fs.writeFile(path.join(source,"package.json"),JSON.stringify(manifest));
  await fs.symlink("/etc/passwd",path.join(source,"escape"));
  run(["update","lifecycle-fixture"],false);
  assert.deepEqual(await fs.readdir(path.join(root,"extensions")),["lifecycle-fixture"]);
  const data = path.join(root,"extension-data/lifecycle-fixture");
  await fs.mkdir(data,{recursive:true}); await fs.writeFile(path.join(data,"storage.json"),'{"kept":true}');
  run(["remove","lifecycle-fixture"]);
  assert.deepEqual(await fs.readdir(path.join(root,"extensions")),[]);
  assert.equal(await fs.readFile(path.join(data,"storage.json"),"utf8"),'{"kept":true}');
  console.log("Extension lifecycle passed: install, duplicate rejection, update, dependency failure rollback, symlink rejection, staging cleanup, and data-preserving uninstall");
} finally { await fs.rm(temporary,{recursive:true,force:true}); }
