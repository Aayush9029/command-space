import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {createServer} from "node:http";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {install} from "../runtime/updater.mjs";

const run = promisify(execFile);
const source = path.resolve(process.argv[2]);
const name = path.basename(source);
const [,version] = /^command-space-(\d+\.\d+\.\d+)-linux-(aarch64|x86_64)\.tar\.gz$/.exec(name) || [];
assert.ok(version,"Supply a Linux release archive");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(),"command-space-isolated-update-"));
const savedEnvironment = Object.fromEntries(["XDG_DATA_HOME","XDG_STATE_HOME","PATH","COMMAND_SPACE_TEST_LOG"].map(key => [key,process.env[key]]));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
let archive;
const server = createServer((request,response) => {
  if (request.url === "/release") {
    const origin = `http://127.0.0.1:${server.address().port}`;
    response.setHeader("Content-Type","application/json");
    response.end(JSON.stringify({tag_name:`v${version}`,assets:[name,`${name}.sha256`].map(name => ({name,browser_download_url:`${origin}/${name}`}))}));
  } else response.end(request.url.endsWith(".sha256") ? `${hash(archive)}  ${name}\n` : archive);
});
try {
  process.env.XDG_DATA_HOME = path.join(temporary,"data");
  process.env.XDG_STATE_HOME = path.join(temporary,"state");
  process.env.COMMAND_SPACE_TEST_LOG = path.join(temporary,"service-calls");
  const helpers = path.join(temporary,"helpers");
  await fs.mkdir(helpers);
  await fs.writeFile(path.join(helpers,"systemctl"),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$COMMAND_SPACE_TEST_LOG"\n',{mode:0o755});
  await fs.writeFile(path.join(helpers,"notify-send"),'#!/bin/sh\nexit 0\n',{mode:0o755});
  process.env.PATH = `${helpers}:${savedEnvironment.PATH}`;
  const target = path.join(process.env.XDG_DATA_HOME,"command-space");
  const preserved = ["extensions/user-extension/source.ts","extension-data/developer-tools/storage.json"];
  for (const file of preserved) {
    await fs.mkdir(path.dirname(path.join(target,file)),{recursive:true});
    await fs.writeFile(path.join(target,file),`preserved ${file}`);
  }
  await run("python3",[fileURLToPath(new URL("../runtime/unpack-release.py",import.meta.url)),source,temporary],{timeout:30000});
  const bundle = path.join(temporary,"command-space");
  const makeArchive = async installer => {
    await fs.writeFile(path.join(bundle,"scripts/install-linux.sh"),installer);
    const output = path.join(temporary,"fixture.tar.gz");
    await run("tar",["--format=ustar","--dereference","--hard-dereference","-czf",output,"-C",temporary,"command-space"],{timeout:30000});
    archive = await fs.readFile(output);
  };
  const validInstaller = `#!/bin/bash
set -euo pipefail
project=$(cd "$(dirname "$0")/.." && pwd)
target="$XDG_DATA_HOME/command-space"
mkdir -p "$target/bin" "$target/runtime" "$target/bundled-extensions" "$target/extensions"
cp "$project/bin/command-space" "$target/bin/command-space"
rsync -a --delete "$project/runtime/" "$target/runtime/"
rsync -a --delete "$project/extensions/" "$target/bundled-extensions/"
for bundled in "$project/extensions"/*; do
  [[ -d "$bundled" ]] || continue
  destination="$target/extensions/$(basename "$bundled")"
  mkdir -p "$destination"
  rsync -a --delete "$bundled/" "$destination/"
done
`;
  await makeArchive(validInstaller);
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  const options = {api:`http://127.0.0.1:${server.address().port}/release`};
  const status = path.join(process.env.XDG_STATE_HOME,"command-space/updates/status.json");
  await install(version,"0.0.0",options);
  assert.equal(JSON.parse(await fs.readFile(status,"utf8")).state,"complete");
  const tracked = ["bin/command-space","runtime/host.mjs"];
  for (const extension of await fs.readdir(path.join(bundle,"extensions"))) {
    tracked.push(`extensions/${extension}/package.json`,`bundled-extensions/${extension}/package.json`);
  }
  const installed = new Map();
  for (const file of tracked) installed.set(file,hash(await fs.readFile(path.join(target,file))));
  await makeArchive(`${validInstaller}
printf 'broken runtime' > "$target/runtime/host.mjs"
cp /bin/false "$target/bin/command-space"
for bundled in "$target/bundled-extensions"/*; do
  printf 'broken extension' > "$bundled/package.json"
  printf 'broken extension' > "$target/extensions/$(basename "$bundled")/package.json"
done
exit 42
`);
  await assert.rejects(install(version,"0.0.0",options),/previous version was restored/);
  for (const [file,digest] of installed) assert.equal(hash(await fs.readFile(path.join(target,file))),digest,`Rollback did not restore ${file}`);
  for (const file of preserved) assert.equal(await fs.readFile(path.join(target,file),"utf8"),`preserved ${file}`);
  assert.equal(JSON.parse(await fs.readFile(status,"utf8")).state,"failed");
  assert.equal(await fs.readFile(process.env.COMMAND_SPACE_TEST_LOG,"utf8"),"--user stop command-space.service\n--user restart command-space.service\n");
  console.log(`Verified isolated update download, install, and rollback of ${tracked.length} binary, runtime, and bundled-extension files; user data preserved`);
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve));
  for (const [key,value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(temporary,{recursive:true,force:true});
}
