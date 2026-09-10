import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
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
  for (const required of ["runtime/host.mjs","runtime/package-lock.json","scripts/install-linux.sh","scripts/start-daemon.sh"]) await fs.access(path.join(packagePath,required));
  return packagePath;
}

async function writeStatus(value) {
  const file = path.join(stateDirectory(), "status.json"), temporary = `${file}.tmp`;
  await fs.mkdir(stateDirectory(), {recursive:true, mode:0o700});
  await fs.writeFile(temporary, JSON.stringify({...value, time:new Date().toISOString()}), {mode:0o600});
  await fs.rename(temporary,file);
}

export async function install(version, current, options = {}) {
  const directory = stateDirectory(), target = installDirectory();
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const lock = path.join(directory,"lock");
  try { await fs.mkdir(lock); } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner;
    try { owner = JSON.parse(await fs.readFile(path.join(lock,"owner.json"),"utf8")); }
    catch { throw new Error("Another Command Space update is starting"); }
    try { process.kill(owner.pid,0); throw new Error("Another Command Space update is running"); }
    catch (error) {
      if (error.code !== "ESRCH") throw error;
      await fs.rm(lock,{recursive:true,force:true});
      await fs.mkdir(lock);
    }
  }
  await fs.writeFile(path.join(lock,"owner.json"), JSON.stringify({pid:process.pid}), {mode:0o600});
  let staging;
  try {
    await writeStatus({state:"downloading",version});
    const release = await check(current,options);
    if (!release.available || release.version !== version) throw new Error("The available release changed; check for updates again");
    staging = await fs.mkdtemp(path.join(directory,"staging-"));
    const packagePath = await prepare(release,staging);
    const previous = path.join(directory,"previous");
    await fs.rm(previous,{recursive:true,force:true});
    await fs.mkdir(previous,{mode:0o700});
    for (const name of ["bin","runtime"]) await fs.cp(path.join(target,name),path.join(previous,name),{recursive:true});
    await writeStatus({state:"installing",version});
    try {
      await run("bash",[path.join(packagePath,"scripts/install-linux.sh"),"--prebuilt"],{timeout:120000,maxBuffer:4*1024*1024});
    } catch (error) {
      await run("systemctl",["--user","stop","command-space.service"]).catch(() => {});
      for (const name of ["bin","runtime"]) {
        await fs.rm(path.join(target,name),{recursive:true,force:true});
        await fs.cp(path.join(previous,name),path.join(target,name),{recursive:true});
      }
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
    if (staging) await fs.rm(staging,{recursive:true,force:true});
    await fs.rm(lock,{recursive:true,force:true});
  }
}

if (process.argv[1] && fsSync.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "install") await install(process.argv[3], process.argv[4]);
    else console.log(JSON.stringify(await check(process.argv[3])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
