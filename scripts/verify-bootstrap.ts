import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {fileURLToPath} from "node:url";
import {createHash, type BinaryLike} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";

assert.ok(process.versions.bun, "Run this validator with Bun");
const run = promisify(execFile);
const fixture = (name: string) => fileURLToPath(new URL(`fixtures/installer/${name}`, import.meta.url));
const archiveArgument = process.argv[2];
assert.ok(archiveArgument, "Supply a Linux release archive");
const archive = path.resolve(archiveArgument);
const name = path.basename(archive);
const [, version, architecture] = /^super-space-(\d+\.\d+\.\d+)-linux-(aarch64|x86_64)\.tar\.gz$/.exec(name) || [];
assert.ok(version && architecture, "Supply a Linux release archive");
const installer = fileURLToPath(new URL("install.sh", import.meta.url));
const bootstrap = fileURLToPath(new URL("installer/bootstrap.py", import.meta.url));
const bootstrapUrl = "https://raw.githubusercontent.com/Aayush9029/super-space/master/scripts/installer/bootstrap.py";
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "cs-bootstrap-"));
const hash = (bytes: BinaryLike) => createHash("sha256").update(bytes).digest("hex");
const api = "https://api.github.com/repos/Aayush9029/super-space/releases/latest";
const releaseUrl = `https://github.com/Aayush9029/super-space/releases/download/v${version}/${name}`;
const bunAsset = architecture === "aarch64" ? "bun-linux-aarch64" : "bun-linux-x64-baseline";
const bunUrl = `https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/${bunAsset}.zip`;
let checks = 0;

interface ReleaseMetadata {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: Array<{name: string; browser_download_url: string}>;
}

interface BootstrapCase {
  noOmarchy?: boolean;
  noBun?: boolean;
  bytes?: Uint8Array;
  badHash?: boolean;
  metadata?: Partial<ReleaseMetadata>;
  badHelper?: boolean;
  bunZip?: string;
  env?: NodeJS.ProcessEnv;
  piped?: boolean;
  error?: RegExp;
}

type CommandFailure = Error & {stdout?: string | Buffer; stderr?: string | Buffer};

try {
  const bundleRoot = path.join(temporary, "bundle");
  await fs.mkdir(bundleRoot);
  await run("python3", [fileURLToPath(new URL("../runtime/unpack-release.py", import.meta.url)), archive, bundleRoot]);
  const bundle = path.join(bundleRoot, "super-space");
  await fs.copyFile(fixture("bootstrap-install.sh"), path.join(bundle, "scripts/install-linux.sh"));
  const fixtureArchive = path.join(temporary, "fixture.tar.gz");
  await run("tar", ["--format=ustar", "--dereference", "--hard-dereference", "-czf", fixtureArchive, "-C", bundleRoot, "super-space"]);
  const validBytes = await fs.readFile(fixtureArchive);
  const bootstrapSource = await fs.readFile(bootstrap, "utf8");
  const currentRequired = 'required = ("scripts/install-linux.sh", "bin/super-space", "runtime/bun.lock")';
  const legacyRequired = 'required = ("scripts/install-linux.sh", "bin/super-space", "runtime/bun.lock", "runtime/host.mjs")';
  assert.equal(bootstrapSource.split(currentRequired).length, 2, "The legacy bootstrap fixture must preserve the previous required-file check");
  const legacyBootstrap = path.join(temporary, "legacy-bootstrap.py");
  await fs.writeFile(legacyBootstrap, bootstrapSource.replace(currentRequired, legacyRequired));
  const legacyPreflight = 'import runpy, sys; runpy.run_path(sys.argv[1])["unpack_package"](*sys.argv[2:])';
  const legacyChecksum = path.join(temporary, "legacy-checksum");
  await fs.writeFile(legacyChecksum, `${hash(validBytes)}  ${name}\n`);
  const legacyDestination = path.join(temporary, "legacy-unpacked");
  await run("python3", ["-B", "-c", legacyPreflight, legacyBootstrap, fixtureArchive, legacyChecksum, name, legacyDestination, architecture]);
  assert.deepEqual(await fs.readFile(path.join(legacyDestination, "super-space/runtime/host.mjs")), await fs.readFile(path.join(bundle, "runtime/host.mjs")));
  checks++;
  console.log("Passed bootstrap: legacy required-file preflight accepts the packaged host compatibility shim");
  const withoutShim = path.join(temporary, "without-host-shim.tar.gz");
  const shim = path.join(bundle, "runtime/host.mjs");
  const savedShim = path.join(temporary, "saved-host-shim.mjs");
  await fs.rename(shim, savedShim);
  try {
    await run("tar", ["--format=ustar", "--dereference", "--hard-dereference", "-czf", withoutShim, "-C", bundleRoot, "super-space"]);
  } finally {
    await fs.rename(savedShim, shim);
  }
  await fs.writeFile(legacyChecksum, `${hash(await fs.readFile(withoutShim))}  ${name}\n`);
  const rejectedDestination = path.join(temporary, "legacy-rejected");
  await assert.rejects(run("python3", ["-B", "-c", legacyPreflight, legacyBootstrap, withoutShim, legacyChecksum, name, rejectedDestination, architecture]), /Package is incomplete: missing runtime\/host\.mjs/);
  await assert.rejects(fs.access(rejectedDestination), {code:"ENOENT"});
  checks++;
  console.log("Passed bootstrap: legacy required-file preflight rejects a package missing its compatibility shim before extraction");
  const maliciousArchive = async (kind: string) => {
    const destination = path.join(temporary, `${kind}.tar.gz`);
    await run("python3", [fixture("malicious-archive.py"), fixtureArchive, destination, kind]);
    return fs.readFile(destination);
  };
  const helpers = path.join(temporary, "helpers");
  await fs.mkdir(helpers);
  for (const command of ["bash", "python3", "sha256sum", "mktemp", "rm", "cat", "mkdir", "install", "mv", "flock", "dirname"]) {
    const {stdout} = await run("/bin/sh", ["-c", 'command -v "$1"', "bootstrap-test", command]);
    await fs.symlink(stdout.trim(), path.join(helpers, command));
  }
  const helper = path.join(temporary, "helper.py");
  await fs.copyFile(fixture("bootstrap-command.py"), helper);
  await fs.chmod(helper, 0o755);
  for (const command of ["uname", "id", "systemctl", "pacman", "sudo", "curl"]) await fs.symlink(helper, path.join(helpers, command));

  const runCase = async (label: string, options: BootstrapCase = {}) => {
    const directory = await fs.mkdtemp(path.join(temporary, "case-"));
    const home = path.join(directory, "home");
    const tmp = path.join(directory, "tmp");
    await fs.mkdir(path.join(home, ".config/hypr"), {recursive:true});
    await fs.mkdir(tmp);
    if (!options.noOmarchy) await fs.writeFile(path.join(home, ".config/hypr/hyprland.lua"), "existing configuration\n");
    const preserved = path.join(home, ".local/share/super-space/bin/super-space");
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
    await fs.writeFile(transportFile, JSON.stringify({[bootstrapUrl]:options.badHelper ? metadataFile : bootstrap, [api]:metadataFile, [releaseUrl]:archiveFile, [`${releaseUrl}.sha256`]:checksumFile, ...(options.bunZip ? {[bunUrl]:options.bunZip} : {})}));
    const env: NodeJS.ProcessEnv = {...process.env, HOME:home, PATH:helpers, TMPDIR:tmp, CS_TEST_ARCH:architecture, CS_TEST_TRANSPORT:transportFile, SUPER_SPACE_BOOTSTRAP_CALLS:callsFile, ...options.env};
    for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "BUN_INSTALL"]) delete env[key];
    let error: CommandFailure | undefined;
    const invocation = options.piped
      ? ["-o", "pipefail", "-c", 'cat -- "$1" | /bin/bash', "bootstrap-test", installer]
      : [installer];
    try { await run("/bin/bash", invocation, {env, timeout:60000}); } catch (value) {
      assert.ok(value instanceof Error, `${label} must return a command error`);
      error = value;
    }
    const calls = await fs.readFile(callsFile, "utf8");
    if (options.error) {
      assert.ok(error, `${label} must reject`);
      assert.match(`${error.stdout ?? ""}\n${error.stderr ?? ""}`, options.error, label);
      await assert.rejects(fs.access(path.join(home, "install-result")));
      assert.equal(await fs.readFile(preserved, "utf8"), "existing app", label);
      assert.doesNotMatch(calls, /\["sudo"|--prebuilt/, label);
      if (options.badHelper) assert.ok(!calls.includes(api), "A mismatched helper must never run");
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
  await runCase("piped installer with existing Bun", {piped:true});
  await runCase("installer helper checksum mismatch", {badHelper:true, error:/Installer helper checksum does not match/});
  await runCase("installer helper network failure", {env:{CS_TEST_FAILED_DOWNLOAD:bootstrapUrl}, error:/simulated download failure/});
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
