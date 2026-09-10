import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtemp, rm, writeFile, readFile, mkdir, utimes} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {execFile, spawn} from "node:child_process";
import {once} from "node:events";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {check, prepare, newer, acquireUpdateLock, backupInstallation, restoreInstallation} from "../updater.mjs";

const run = promisify(execFile);
const unpack = fileURLToPath(new URL("../unpack-release.py",import.meta.url));

test("release checks compare versions numerically and select a verified native artifact", async t => {
  assert.equal(newer("v0.10.0","0.9.9"),true);
  assert.equal(newer("0.1.0","0.1.0"),false);
  assert.equal(newer("0.1.0","1.0.0"),false);
  assert.throws(() => newer("main","0.1.0"),/Invalid release/);
  let status = 200;
  const release = {tag_name:"v0.2.0",body:"A Linux update",assets:[]};
  const server = createServer((request,response) => {
    if (request.url === "/release") {response.writeHead(status,{"Content-Type":"application/json"}); response.end(JSON.stringify(release));}
    else response.end(request.url.endsWith("sha256") ? `${"0".repeat(64)}  command-space-0.2.0-linux-aarch64.tar.gz\n` : "broken download");
  });
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = `${origin}/release`;
  const name = "command-space-0.2.0-linux-aarch64.tar.gz";
  release.assets = [name,`${name}.sha256`].map(name => ({name,browser_download_url:`${origin}/${name}`}));
  const result = await check("0.1.0",{api,arch:"arm64"});
  assert.equal(result.available,true); assert.equal(result.architecture,"aarch64");
  assert.equal((await check("0.2.0",{api,arch:"arm64"})).available,false);
  await assert.rejects(check("0.1.0",{api,arch:"x64"}),/no verified package/);
  const x64 = "command-space-0.2.0-linux-x86_64.tar.gz";
  release.assets.push(...[x64,`${x64}.sha256`].map(name => ({name,browser_download_url:`${origin}/${name}`})));
  assert.equal((await check("0.1.0",{api,arch:"x64"})).architecture,"x86_64");
  const directory = await mkdtemp(path.join(tmpdir(),"cs-update-"));
  t.after(() => rm(directory,{recursive:true,force:true}));
  await assert.rejects(prepare(result,directory),/checksum did not match/);
  release.assets[0].browser_download_url = "https://example.com/untrusted.tar.gz";
  await assert.rejects(check("0.1.0",{api,arch:"arm64"}),/outside the Command Space repository/);
  status = 404;
  assert.match((await check("0.1.0",{api})).message,/No published Linux release/);
});

test("update lock excludes contenders and is released when its owner crashes", {skip:process.platform !== "linux", timeout:10000}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(),"cs-update-lock-"));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const held = await acquireUpdateLock(directory);
  try {
    await Promise.all(Array.from({length:8}, () => assert.rejects(acquireUpdateLock(directory),/Another Command Space update is running/)));
  } finally { await held.close(); }
  await (await acquireUpdateLock(directory)).close();
  const updater = new URL("../updater.mjs",import.meta.url).href;
  const child = spawn(process.execPath,["--input-type=module","-e",`import {acquireUpdateLock} from ${JSON.stringify(updater)}; const lock = await acquireUpdateLock(process.argv[1]); process.stdout.write("locked\\n"); setInterval(() => { if (lock.fd < 0) process.exit(1); },1000);`,directory],{stdio:["ignore","pipe","pipe"]});
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const exited = once(child,"exit");
  await Promise.race([once(child.stdout,"data"),exited.then(() => {throw new Error("Lock owner exited before acquiring the lock");})]);
  await assert.rejects(acquireUpdateLock(directory),/Another Command Space update is running/);
  child.kill("SIGKILL");
  await exited;
  await (await acquireUpdateLock(directory)).close();
});

test("updater recovers abandoned legacy locks without overlapping a live legacy update", {skip:process.platform !== "linux"}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(),"cs-update-legacy-lock-"));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const legacy = path.join(directory,"lock");
  await mkdir(legacy);
  await assert.rejects(acquireUpdateLock(directory),/update is starting/);
  const abandoned = new Date(Date.now() - 60000);
  await utimes(legacy,abandoned,abandoned);
  await (await acquireUpdateLock(directory)).close();
  await writeFile(path.join(legacy,"owner.json"),"{interrupted write");
  await utimes(legacy,abandoned,abandoned);
  await (await acquireUpdateLock(directory)).close();
  await writeFile(path.join(legacy,"owner.json"),JSON.stringify({pid:process.pid}));
  await assert.rejects(acquireUpdateLock(directory),/Another Command Space update is running/);
  await rm(legacy,{recursive:true});
  await (await acquireUpdateLock(directory)).close();
});

test("failed updates restore bundled extensions while preserving user extensions and stored data", async t => {
  const directory = await mkdtemp(path.join(tmpdir(),"cs-update-rollback-"));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const target = path.join(directory,"installed"), previous = path.join(directory,"previous"), release = path.join(directory,"release");
  for (const name of ["developer-tools","omarchy-tools"]) {
    await mkdir(path.join(release,"extensions",name),{recursive:true});
    await writeFile(path.join(release,"extensions",name,"package.json"),JSON.stringify({name}));
  }
  const original = {"bin/command-space":"working binary","runtime/host.mjs":"working host","extensions/developer-tools/source.ts":"original command","extensions/user-extension/source.ts":"user code","extension-data/developer-tools/storage.json":"user data"};
  for (const [file,content] of Object.entries(original)) {
    await mkdir(path.dirname(path.join(target,file)),{recursive:true});
    await writeFile(path.join(target,file),content);
  }
  const snapshot = await backupInstallation(target,previous,release);
  for (const file of ["bin/command-space","runtime/host.mjs","extensions/developer-tools/source.ts","extensions/omarchy-tools/source.ts","bundled-extensions/omarchy-tools/source.ts"]) {
    await mkdir(path.dirname(path.join(target,file)),{recursive:true});
    await writeFile(path.join(target,file),"broken update");
  }
  await restoreInstallation(target,previous,snapshot);
  for (const [file,content] of Object.entries(original)) assert.equal(await readFile(path.join(target,file),"utf8"),content);
  await assert.rejects(readFile(path.join(target,"extensions/omarchy-tools/source.ts")),{code:"ENOENT"});
  await assert.rejects(readFile(path.join(target,"bundled-extensions/omarchy-tools/source.ts")),{code:"ENOENT"});
});

test("release extraction rejects traversal and links and extracts ordinary package files", async t => {
  const directory = await mkdtemp(path.join(tmpdir(),"cs-unpack-"));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const generator = path.join(directory,"generate.py"), archive = path.join(directory,"release.tar.gz");
  await writeFile(generator, `import io,sys,tarfile\nwith tarfile.open(sys.argv[1],"w:gz",format=tarfile.USTAR_FORMAT) as archive:\n member=tarfile.TarInfo(sys.argv[2])\n if len(sys.argv)>3: member.type=tarfile.SYMTYPE; member.linkname="/tmp/escape"\n else: member.size=7\n archive.addfile(member,io.BytesIO(b"fixture"))\n`);
  const output = path.join(directory,"output"); await mkdir(output);
  for (const [name,link] of [["command-space/../../escape",false],["/tmp/escape",false],["command-space/linked",true]]) {
    await run("python3",[generator,archive,name,...(link?["link"]:[])]);
    await assert.rejects(run("python3",[unpack,archive,output]),/invalid path|link or special file/);
  }
  await run("python3",[generator,archive,"command-space/README.md"]);
  await run("python3",[unpack,archive,output]);
  assert.equal(await readFile(path.join(output,"command-space/README.md"),"utf8"),"fixture");
});
