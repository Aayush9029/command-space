import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";

assert.ok(process.versions.bun, "Run this validator with Bun");
const run = promisify(execFile);
const archive = path.resolve(process.argv[2]);
const name = path.basename(archive);
const [, version, architecture] = /^command-space-(\d+\.\d+\.\d+)-linux-(aarch64|x86_64)\.tar\.gz$/.exec(name) || [];
assert.ok(version, "Supply a Linux release archive");
const installer = fileURLToPath(new URL("install.sh", import.meta.url));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "cs-bootstrap-"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const api = "https://api.github.com/repos/Aayush9029/command-space/releases/latest";
const releaseUrl = `https://github.com/Aayush9029/command-space/releases/download/v${version}/${name}`;
const bunAsset = architecture === "aarch64" ? "bun-linux-aarch64" : "bun-linux-x64-baseline";
const bunUrl = `https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/${bunAsset}.zip`;
let checks = 0;

try {
  const bundleRoot = path.join(temporary, "bundle");
  await fs.mkdir(bundleRoot);
  await run("python3", [fileURLToPath(new URL("../runtime/unpack-release.py", import.meta.url)), archive, bundleRoot]);
  const bundle = path.join(bundleRoot, "command-space");
  await fs.writeFile(path.join(bundle, "scripts/install-linux.sh"), `#!/bin/bash
set -euo pipefail
[[ "$#" == 1 && "$1" == --prebuilt ]]
printf 'installed\\n' > "$HOME/install-result"
printf '%s\\n' "$*" >> "$COMMAND_SPACE_BOOTSTRAP_CALLS"
`);
  const fixtureArchive = path.join(temporary, "fixture.tar.gz");
  await run("tar", ["--format=ustar", "--dereference", "--hard-dereference", "-czf", fixtureArchive, "-C", bundleRoot, "command-space"]);
  const validBytes = await fs.readFile(fixtureArchive);
  const maliciousArchive = async kind => {
    const destination = path.join(temporary, `${kind}.tar.gz`);
    await run("python3", ["-c", `import sys,tarfile,io
source,destination,kind=sys.argv[1:]
with tarfile.open(source,'r:gz') as original, tarfile.open(destination,'w:gz',format=tarfile.USTAR_FORMAT) as target:
 for item in original:
  target.addfile(item,original.extractfile(item) if item.isfile() else None)
 item=tarfile.TarInfo('command-space/extra')
 if kind=='traversal': item.name='command-space/../../escaped'
 if kind=='symlink': item.type=tarfile.SYMTYPE; item.linkname='../../escaped'
 if kind=='hardlink': item.type=tarfile.LNKTYPE; item.linkname='command-space/bin/command-space'
 if kind=='duplicate': item.name='command-space/bin/command-space'
 target.addfile(item,io.BytesIO(b''))
`, fixtureArchive, destination, kind]);
    return fs.readFile(destination);
  };
  const helpers = path.join(temporary, "helpers");
  await fs.mkdir(helpers);
  for (const command of ["bash", "python3", "mktemp", "rm", "cat", "mkdir", "install", "mv", "flock", "dirname"]) {
    const {stdout} = await run("/bin/sh", ["-c", 'command -v "$1"', "bootstrap-test", command]);
    await fs.symlink(stdout.trim(), path.join(helpers, command));
  }
  const python = (await run("/bin/sh", ["-c", "command -v python3"])).stdout.trim();
  const helper = path.join(temporary, "helper.py");
  await fs.writeFile(helper, `#!${python}
import json,os,pathlib,shutil,sys
command=pathlib.Path(sys.argv[0]).name
args=sys.argv[1:]
with open(os.environ['COMMAND_SPACE_BOOTSTRAP_CALLS'],'a') as log: log.write(json.dumps([command,*args])+'\\n')
if command=='uname': print(os.environ.get('CS_TEST_OS','Linux') if args==['-s'] else os.environ['CS_TEST_ARCH'])
elif command=='id': print(os.environ.get('CS_TEST_UID','1000'))
elif command=='systemctl':
 if os.environ.get('CS_TEST_NO_SESSION'): sys.exit(1)
 print('WAYLAND_DISPLAY=wayland-test')
elif command=='pacman': sys.exit(1 if os.environ.get('CS_TEST_MISSING_DEPS') else 0)
elif command=='sudo': sys.exit(99)
elif command=='curl':
 assert '--proto' in args and args[args.index('--proto')+1]=='=https'
 assert '--proto-redir' in args and args[args.index('--proto-redir')+1]=='=https'
 with open(os.environ['CS_TEST_TRANSPORT']) as source: routes=json.load(source)
 url=args[-1]
 if url not in routes: print('Unexpected download: '+url,file=sys.stderr); sys.exit(22)
 if os.environ.get('CS_TEST_FAILED_DOWNLOAD')==url: sys.exit(22)
 source=routes[url]; target=args[args.index('--output')+1]
 assert pathlib.Path(source).stat().st_size <= int(args[args.index('--max-filesize')+1])
 shutil.copyfile(source,target)
`, {mode:0o755});
  for (const command of ["uname", "id", "systemctl", "pacman", "sudo", "curl"]) await fs.symlink(helper, path.join(helpers, command));

  const runCase = async (label, options = {}) => {
    const directory = await fs.mkdtemp(path.join(temporary, "case-"));
    const home = path.join(directory, "home");
    const tmp = path.join(directory, "tmp");
    await fs.mkdir(path.join(home, ".config/hypr"), {recursive:true});
    await fs.mkdir(tmp);
    if (!options.noOmarchy) await fs.writeFile(path.join(home, ".config/hypr/hyprland.lua"), "existing configuration\n");
    const preserved = path.join(home, ".local/share/command-space/bin/command-space");
    await fs.mkdir(path.dirname(preserved), {recursive:true});
    await fs.writeFile(preserved, "existing app");
    if (!options.noBun) {
      await fs.mkdir(path.join(home, ".bun/bin"), {recursive:true});
      await fs.symlink(process.execPath, path.join(home, ".bun/bin/bun"));
    }
    const bytes = options.bytes || validBytes;
    const archiveFile = path.join(directory, name);
    const checksumFile = path.join(directory, "checksum");
    const metadataFile = path.join(directory, "release.json");
    const transportFile = path.join(directory, "transport.json");
    const callsFile = path.join(directory, "calls");
    await fs.writeFile(callsFile, "");
    await fs.writeFile(archiveFile, bytes);
    await fs.writeFile(checksumFile, `${options.badHash ? "0".repeat(64) : hash(bytes)}  ${name}\n`);
    const release = {tag_name:`v${version}`, draft:false, prerelease:false, assets:[name, `${name}.sha256`].map((asset, index) => ({name:asset, browser_download_url:`${releaseUrl}${index ? ".sha256" : ""}`})), ...options.metadata};
    await fs.writeFile(metadataFile, JSON.stringify(release));
    await fs.writeFile(transportFile, JSON.stringify({[api]:metadataFile, [releaseUrl]:archiveFile, [`${releaseUrl}.sha256`]:checksumFile, ...(options.bunZip ? {[bunUrl]:options.bunZip} : {})}));
    const env = {...process.env, HOME:home, PATH:helpers, TMPDIR:tmp, CS_TEST_ARCH:architecture, CS_TEST_TRANSPORT:transportFile, COMMAND_SPACE_BOOTSTRAP_CALLS:callsFile, ...options.env};
    for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "BUN_INSTALL"]) delete env[key];
    let error;
    try { await run("/bin/bash", [installer], {env, timeout:60000}); } catch (value) { error = value; }
    const calls = await fs.readFile(callsFile, "utf8");
    if (options.error) {
      assert.ok(error, `${label} must reject`);
      assert.match(`${error.stdout}\n${error.stderr}`, options.error, label);
      await assert.rejects(fs.access(path.join(home, "install-result")));
      assert.equal(await fs.readFile(preserved, "utf8"), "existing app", label);
      assert.doesNotMatch(calls, /\["sudo"|--prebuilt/, label);
      if (options.noBun) await assert.rejects(fs.access(path.join(home, ".bun/bin/bun")));
    } else {
      assert.ifError(error);
      assert.equal(await fs.readFile(path.join(home, "install-result"), "utf8"), "installed\n");
      assert.match(calls, /--prebuilt/);
      if (options.noBun) assert.equal((await run(path.join(home, ".bun/bin/bun"), ["--version"])).stdout.trim(), "1.4.2");
    }
    assert.deepEqual(await fs.readdir(tmp), [], `${label} must clean temporary files`);
    checks++;
    console.log(`Passed bootstrap: ${label}`);
  };

  await runCase("verified download with existing Bun");
  await runCase("root refusal", {env:{CS_TEST_UID:"0"}, error:/without sudo/});
  await runCase("macOS refusal", {env:{CS_TEST_OS:"Darwin"}, error:/Omarchy Linux/});
  await runCase("unsupported architecture", {env:{CS_TEST_ARCH:"riscv64"}, error:/Unsupported architecture/});
  await runCase("missing Omarchy config", {noOmarchy:true, error:/configuration was not found/});
  await runCase("missing user session", {env:{CS_TEST_NO_SESSION:"1"}, error:/session is unavailable/});
  await runCase("old Node release", {metadata:{tag_name:"v1.0.1"}, error:/Bun-compatible/});
  await runCase("prerelease refusal", {metadata:{prerelease:true}, error:/stable published release/});
  await runCase("foreign download URL", {metadata:{assets:[{name, browser_download_url:"https://example.com/release.tar.gz"}]}, error:/invalid release asset/});
  await runCase("network failure", {env:{CS_TEST_FAILED_DOWNLOAD:releaseUrl}, error:/Downloading/});
  await runCase("checksum mismatch", {badHash:true, error:/checksum does not match/});
  for (const kind of ["traversal", "symlink", "hardlink", "duplicate"]) {
    await runCase(`${kind} archive rejected`, {bytes:await maliciousArchive(kind), error:/invalid path|duplicate paths, links, or special files/});
  }
  const bunZip = path.join(temporary, "bun.zip");
  await run("curl", ["--fail", "--location", "--silent", "--show-error", "--proto", "=https", "--proto-redir", "=https", "--max-time", "180", "--output", bunZip, bunUrl], {timeout:190000});
  await runCase("verified first-time Bun installation", {noBun:true, bunZip});
  const corruptBun = path.join(temporary, "corrupt-bun.zip");
  await fs.writeFile(corruptBun, "corrupt Bun archive");
  await runCase("Bun checksum mismatch", {noBun:true, bunZip:corruptBun, error:/checksum does not match/});
  console.log(`Verified ${checks} bootstrap scenarios without modifying the desktop or system packages`);
} finally {
  await fs.rm(temporary, {recursive:true, force:true});
}
