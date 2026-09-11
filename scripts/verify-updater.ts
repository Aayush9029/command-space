import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {fileURLToPath} from "node:url";
import {createHash, type BinaryLike} from "node:crypto";
import {createServer} from "node:http";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {install} from "../runtime/updater.ts";

const run = promisify(execFile);
const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = path.join(os.homedir(),".local/share/super-space");
const binary = path.join(target,"bin/super-space");
const {stdout} = await run(binary,["--version"]);
const version = stdout.trim().split(" ").at(-1);
assert.ok(version, "The installed launcher must report a version");
const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
const name = `super-space-${version}-linux-${architecture}.tar.gz`;
let archive = await fs.readFile(path.join(project,"dist",name));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(),"super-space-update-test-"));
const hash = (bytes: BinaryLike) => createHash("sha256").update(bytes).digest("hex");
const config = path.join(os.homedir(),".config/super-space/config.toml");
const originalConfig = await fs.readFile(config);
function serverOrigin() {
  const address = server.address();
  assert.ok(address && typeof address === "object", "The fixture server must be listening on TCP");
  return `http://127.0.0.1:${address.port}`;
}
const server = createServer((request,response) => {
  if (request.url === "/release") {
    const base = serverOrigin();
    response.setHeader("Content-Type","application/json");
    response.end(JSON.stringify({tag_name:`v${version}`,assets:[name,`${name}.sha256`].map(name => ({name,browser_download_url:`${base}/${name}`}))}));
  } else response.end(request.url?.endsWith(".sha256") ? `${hash(archive)}  ${name}\n` : archive);
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0,"127.0.0.1",resolve);
});
const options = {api:`${serverOrigin()}/release`};
try {
  await install(version,"0.0.0",options);
  assert.deepEqual(await fs.readFile(config),originalConfig);
  await run(binary,["ping"]);
  console.log("Verified package installation and service restart passed");
  const valid = await fs.readFile(binary), validHost = await fs.readFile(path.join(target,"runtime/host.ts"));
  const savedArchive = path.join(temporary,"release.tar.gz");
  await fs.writeFile(savedArchive,archive);
  await run("python3",[path.join(project,"runtime/unpack-release.py"),savedArchive,temporary]);
  await fs.writeFile(path.join(temporary,"super-space/scripts/install-linux.sh"),`#!/bin/bash\nset -e\nroot="$HOME/.local/share/super-space"\ncp /bin/false "$root/bin/super-space.new"\nmv "$root/bin/super-space.new" "$root/bin/super-space"\nprintf 'intentional update failure' > "$root/runtime/host.ts"\nexit 42\n`);
  const badArchive = path.join(temporary,"failed.tar.gz");
  await run("tar",["--format=ustar","--dereference","--hard-dereference","-czf",badArchive,"-C",temporary,"super-space"]);
  archive = await fs.readFile(badArchive);
  await assert.rejects(install(version,"0.0.0",options),/previous version was restored/);
  assert.equal(hash(await fs.readFile(binary)),hash(valid));
  assert.deepEqual(await fs.readFile(path.join(target,"runtime/host.ts")),validHost);
  assert.deepEqual(await fs.readFile(config),originalConfig);
  for (let attempt=0;attempt<100;attempt++) {
    try {await run(binary,["ping"]);break;} catch(error) {if(attempt===99)throw error; await new Promise(resolve => setTimeout(resolve,100));}
  }
  console.log("Failed installation restored the exact binary and runtime; service is healthy");
  const status = path.join(os.homedir(),".local/state/super-space/updates/status.json");
  await fs.rename(status, `${status}.validation`);
} finally {
  server.close();
  await fs.rm(temporary,{recursive:true,force:true});
}
