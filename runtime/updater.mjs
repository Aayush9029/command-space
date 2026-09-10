import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {execFile, spawn} from "node:child_process";
import {promisify} from "node:util";

const run = promisify(execFile);
const runtime = path.dirname(fileURLToPath(import.meta.url));
const repository = "Aayush9029/command-space";
const releaseApi = `https://api.github.com/repos/${repository}/releases/latest`;
const stateDirectory = () => path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "command-space/updates");
const installDirectory = () => path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share"), "command-space");

function parts(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Invalid release version: ${version}`);
  return match.slice(1).map(BigInt);
}
export function newer(version, current) {
  const next = parts(version), installed = parts(current);
  for (let index = 0; index < 3; index++) if (next[index] !== installed[index]) return next[index] > installed[index];
  return false;
}

function trustedUrl(value, api) {
  const url = new URL(value), origin = new URL(api);
  if (url.protocol === "https:" && url.hostname === "github.com" && url.pathname.startsWith(`/${repository}/releases/download/`)) return url.href;
  if (origin.hostname === "127.0.0.1" && origin.protocol === "http:" && url.origin === origin.origin) return url.href;
  throw new Error("Release asset is outside the Command Space repository");
}
async function download(url, maximum) {
  const response = await fetch(url, {headers:{"User-Agent":"Command-Space-Updater"}, signal:AbortSignal.timeout(120000)});
  if (!response.ok || !response.body) throw new Error(`Release download failed (${response.status})`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) throw new Error("Release download exceeds its size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function check(current, {api = releaseApi, arch = process.arch} = {}) {
  const response = await fetch(api, {headers:{"User-Agent":"Command-Space-Updater", Accept:"application/vnd.github+json"}, signal:AbortSignal.timeout(15000)});
  if (response.status === 404) return {current, available:false, message:"No published Linux release is available yet"};
  if (!response.ok) throw new Error(`Checking releases failed (${response.status})`);
  const release = await response.json();
  if (release.draft || release.prerelease) return {current, available:false, message:"No stable release is available"};
  const version = release.tag_name.replace(/^v/, "");
  if (!newer(version, current)) return {current, version, available:false, message:`Command Space ${current} is up to date`};
  const architecture = {arm64:"aarch64", x64:"x86_64"}[arch];
  if (!architecture) throw new Error(`No Linux release is available for ${arch}`);
  const name = `command-space-${version}-linux-${architecture}.tar.gz`;
  const asset = release.assets?.find(asset => asset.name === name);
  const checksum = release.assets?.find(asset => asset.name === `${name}.sha256`);
  if (!asset || !checksum) throw new Error(`Release ${version} has no verified package for ${architecture}`);
  return {current, version, available:true, name, architecture, url:`https://github.com/${repository}/releases/tag/v${version}`, notes:release.body || "", asset:trustedUrl(asset.browser_download_url, api), checksum:trustedUrl(checksum.browser_download_url, api), message:`Command Space ${version} is available`};
}

export async function prepare(release, directory) {
  await fs.mkdir(directory, {recursive:true, mode:0o700});
  const [archive, checksum] = await Promise.all([download(release.asset,128*1024*1024), download(release.checksum,65536)]);
  const expected = checksum.toString("utf8").split("\n").map(line => /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim())).find(match => match?.[2] === release.name)?.[1];
  if (!expected || createHash("sha256").update(archive).digest("hex") !== expected) throw new Error("Release checksum did not match; the installed version was kept");
  const archivePath = path.join(directory, "release.tar.gz");
  await fs.writeFile(archivePath, archive, {mode:0o600, flag:"wx"});
  await run("python3", [path.join(runtime, "unpack-release.py"), archivePath, directory], {timeout:30000});
  const packagePath = path.join(directory, "command-space");
  const executable = path.join(packagePath,"bin/command-space");
  const handle = await fs.open(executable,"r");
  const header = Buffer.alloc(20);
  try { await handle.read(header,0,20,0); } finally { await handle.close(); }
  if (header.subarray(0,4).toString("hex") !== "7f454c46" || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== ({aarch64:183,x86_64:62}[release.architecture])) throw new Error("Release executable has the wrong architecture");
  const {stdout} = await run(executable,["--version"],{timeout:5000});
  if (stdout.trim() !== `Command Space ${release.version}`) throw new Error("Release executable version does not match the requested update");
  for (const required of ["runtime/host.mjs","runtime/bun.lock","scripts/install-linux.sh","scripts/start-daemon.sh"]) await fs.access(path.join(packagePath,required));
  return packagePath;
}

async function writeStatus(value) {
  const file = path.join(stateDirectory(), "status.json"), temporary = `${file}.tmp`;
  await fs.mkdir(stateDirectory(), {recursive:true, mode:0o700});
  await fs.writeFile(temporary, JSON.stringify({...value, time:new Date().toISOString()}), {mode:0o600});
  await fs.rename(temporary,file);
}

export async function acquireUpdateLock(directory) {
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const lock = await fs.open(path.join(directory,"install.lock"),"a",0o600);
  try {
    await new Promise((resolve,reject) => {
      // The inherited descriptor shares its lock with this process and releases it even after a crash.
      const child = spawn("flock",["--nonblock","--conflict-exit-code","75","3"],{stdio:["ignore","ignore","pipe",lock.fd]});
      let diagnostic = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", value => { diagnostic = (diagnostic + value).slice(-4096); });
      child.once("error",reject);
      child.once("exit",code => {
        if (code === 0) resolve();
        else reject(new Error(code === 75 ? "Another Command Space update is running" : `Could not lock the update: ${diagnostic.trim() || `flock exited ${code}`}`));
      });
    });
    const legacy = path.join(directory,"lock");
    let owner;
    try { owner = JSON.parse(await fs.readFile(path.join(legacy,"owner.json"),"utf8")); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
      try { process.kill(owner.pid,0); throw new Error("Another Command Space update is running"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    } else {
      const status = await fs.stat(legacy).catch(error => { if (error.code !== "ENOENT") throw error; });
      if (status && Date.now() - status.mtimeMs < 30000) throw new Error("Another Command Space update is starting; retry in a moment");
    }
    return lock;
  } catch (error) {
    await lock.close();
    throw error;
  }
}

export async function backupInstallation(target, previous, packagePath) {
  const locations = ["bin","runtime","bundled-extensions"];
  for (const entry of await fs.readdir(path.join(packagePath,"extensions"),{withFileTypes:true})) {
    if (!entry.isDirectory()) continue;
    const manifest = JSON.parse(await fs.readFile(path.join(packagePath,"extensions",entry.name,"package.json"),"utf8"));
    if (!/^[a-zA-Z0-9_-]+$/.test(manifest.name)) throw new Error("Release contains an invalid bundled extension ID");
    locations.push(`extensions/${manifest.name}`);
  }
  await fs.rm(previous,{recursive:true,force:true});
  await fs.mkdir(previous,{mode:0o700});
  const snapshot = [];
  for (const location of new Set(locations)) {
    const existed = await fs.stat(path.join(target,location)).then(() => true,error => { if (error.code !== "ENOENT") throw error; return false; });
    if (existed) await fs.cp(path.join(target,location),path.join(previous,location),{recursive:true});
    snapshot.push({location,existed});
  }
  return snapshot;
}

export async function restoreInstallation(target, previous, snapshot) {
  for (const {location,existed} of snapshot) {
    await fs.rm(path.join(target,location),{recursive:true,force:true});
    if (existed) await fs.cp(path.join(previous,location),path.join(target,location),{recursive:true});
  }
}

export async function install(version, current, options = {}) {
  const directory = stateDirectory(), target = installDirectory();
  const lock = await acquireUpdateLock(directory);
  let staging;
  try {
    await writeStatus({state:"downloading",version});
    const release = await check(current,options);
    if (!release.available || release.version !== version) throw new Error("The available release changed; check for updates again");
    staging = await fs.mkdtemp(path.join(directory,"staging-"));
    const packagePath = await prepare(release,staging);
    const previous = path.join(directory,"previous");
    const snapshot = await backupInstallation(target,previous,packagePath);
    await writeStatus({state:"installing",version});
    try {
      await run("bash",[path.join(packagePath,"scripts/install-linux.sh"),"--prebuilt"],{timeout:120000,maxBuffer:4*1024*1024});
    } catch (error) {
      await run("systemctl",["--user","stop","command-space.service"]).catch(() => {});
      await restoreInstallation(target,previous,snapshot);
      await run("systemctl",["--user","restart","command-space.service"]);
      throw new Error(`Update failed and the previous version was restored: ${error.message}`);
    }
    await writeStatus({state:"complete",version});
    await run("notify-send",["--app-name=Command Space",`Updated to Command Space ${version}`]).catch(() => {});
  } catch (error) {
    await writeStatus({state:"failed",version,message:error.message});
    await run("notify-send",["--app-name=Command Space","Command Space update failed",error.message]).catch(() => {});
    throw error;
  } finally {
    try { if (staging) await fs.rm(staging,{recursive:true,force:true}); }
    finally { await lock.close(); }
  }
}

if (process.argv[1] && fsSync.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "install") await install(process.argv[3], process.argv[4]);
    else console.log(JSON.stringify(await check(process.argv[3])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
