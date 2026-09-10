import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtemp, rm, writeFile, readFile, mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {check, prepare, newer} from "../updater.mjs";

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
  const directory = await mkdtemp(path.join(tmpdir(),"cs-update-"));
  t.after(() => rm(directory,{recursive:true,force:true}));
  await assert.rejects(prepare(result,directory),/checksum did not match/);
  release.assets[0].browser_download_url = "https://example.com/untrusted.tar.gz";
  await assert.rejects(check("0.1.0",{api,arch:"arm64"}),/outside the Command Space repository/);
  status = 404;
  assert.match((await check("0.1.0",{api})).message,/No published Linux release/);
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
