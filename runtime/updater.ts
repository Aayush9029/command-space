import fs, {type FileHandle} from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {execFile, spawn} from "node:child_process";
import {promisify} from "node:util";
import {errorCode, isRecord} from "./types.ts";

const run = promisify(execFile);
const runtime = path.dirname(fileURLToPath(import.meta.url));
const repository = "Aayush9029/super-space";
const releaseApi = `https://api.github.com/repos/${repository}/releases/latest`;
const stateDirectory = () => path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "super-space/updates");
const installDirectory = () => path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share"), "super-space");

type Architecture = "aarch64" | "x86_64";
export interface CheckOptions { api?: string; arch?: string }
interface ReleaseAsset { name: string; browser_download_url: string }
interface ReleaseMetadata {
  tag_name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}
export interface AvailableRelease {
  current: string;
  version: string;
  available: true;
  name: string;
  architecture: Architecture;
  url: string;
  notes: string;
  asset: string;
  checksum: string;
  message: string;
}
export type ReleaseCheck = AvailableRelease | {current: string; version?: string; available: false; message: string};
export interface InstallationSnapshot { location: string; existed: boolean }
interface UpdateStatus { state: "downloading" | "installing" | "complete" | "failed"; version: string; message?: string }

function parts(version: string): bigint[] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Invalid release version: ${version}`);
  return match.slice(1).map(BigInt);
}
export function newer(version: string, current: string): boolean {
  const next = parts(version), installed = parts(current);
  for (let index = 0; index < 3; index++) if (next[index] !== installed[index]) return next[index] > installed[index];
  return false;
}

function releaseMetadata(value: unknown): ReleaseMetadata {
  if (!isRecord(value) || typeof value.tag_name !== "string"
    || (value.body != null && typeof value.body !== "string")
    || (value.draft !== undefined && typeof value.draft !== "boolean")
    || (value.prerelease !== undefined && typeof value.prerelease !== "boolean")
    || (value.assets !== undefined && !Array.isArray(value.assets))) throw new Error("Release metadata is invalid");
  const assets: ReleaseAsset[] = [];
  for (const asset of value.assets ?? []) {
    if (!isRecord(asset) || typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") throw new Error("Release asset metadata is invalid");
    assets.push({name: asset.name, browser_download_url: asset.browser_download_url});
  }
  return {tag_name: value.tag_name, body: value.body ?? "", draft: value.draft ?? false, prerelease: value.prerelease ?? false, assets};
}

function trustedUrl(value: string, api: string): string {
  const url = new URL(value), origin = new URL(api);
  if (url.username || url.password) throw new Error("Release asset is outside the Super Space repository");
  if (url.protocol === "https:" && url.hostname === "github.com" && !url.port && url.pathname.startsWith(`/${repository}/releases/download/`)) return url.href;
  if (origin.hostname === "127.0.0.1" && origin.protocol === "http:" && url.origin === origin.origin) return url.href;
  throw new Error("Release asset is outside the Super Space repository");
}
async function download(url: string, maximum: number): Promise<Buffer> {
  const response = await fetch(url, {headers:{"User-Agent":"Super-Space-Updater"}, signal:AbortSignal.timeout(120000)});
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Release download failed (${response.status})`);
  }
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body.cancel();
    throw new Error("Release download exceeds its size limit");
  }
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) throw new Error("Release download exceeds its size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function check(current: string, {api = releaseApi, arch = process.arch}: CheckOptions = {}): Promise<ReleaseCheck> {
  parts(current);
  const response = await fetch(api, {headers:{"User-Agent":"Super-Space-Updater", Accept:"application/vnd.github+json"}, signal:AbortSignal.timeout(15000)});
  if (response.status === 404) return {current, available:false, message:"No published Linux release is available yet"};
  if (!response.ok) throw new Error(`Checking releases failed (${response.status})`);
  const release = releaseMetadata(await response.json());
  if (release.draft || release.prerelease) return {current, available:false, message:"No stable release is available"};
  const version = release.tag_name.replace(/^v/, "");
  if (!newer(version, current)) return {current, version, available:false, message:`Super Space ${current} is up to date`};
  const architecture: Architecture | undefined = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : undefined;
  if (!architecture) throw new Error(`No Linux release is available for ${arch}`);
  const name = `super-space-${version}-linux-${architecture}.tar.gz`;
  const assets = release.assets.filter(asset => asset.name === name);
  const checksums = release.assets.filter(asset => asset.name === `${name}.sha256`);
  if (assets.length !== 1 || checksums.length !== 1) throw new Error(`Release ${version} has no verified package for ${architecture}`);
  return {current, version, available:true, name, architecture, url:`https://github.com/${repository}/releases/tag/v${version}`, notes:release.body, asset:trustedUrl(assets[0].browser_download_url, api), checksum:trustedUrl(checksums[0].browser_download_url, api), message:`Super Space ${version} is available`};
}

export async function prepare(release: AvailableRelease, directory: string): Promise<string> {
  await fs.mkdir(directory, {recursive:true, mode:0o700});
  const [archive, checksum] = await Promise.all([download(release.asset,128*1024*1024), download(release.checksum,65536)]);
  const expected = checksum.toString("utf8").split("\n").map(line => /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim())).find(match => match?.[2] === release.name)?.[1];
  if (!expected || createHash("sha256").update(archive).digest("hex") !== expected) throw new Error("Release checksum did not match; the installed version was kept");
  const archivePath = path.join(directory, "release.tar.gz");
  await fs.writeFile(archivePath, archive, {mode:0o600, flag:"wx"});
  await run("python3", [path.join(runtime, "unpack-release.py"), archivePath, directory], {timeout:30000});
  const packagePath = path.join(directory, "super-space");
  const executable = path.join(packagePath,"bin/super-space");
  const handle = await fs.open(executable,"r");
  const header = Buffer.alloc(20);
  try { await handle.read(header,0,20,0); } finally { await handle.close(); }
  if (header.subarray(0,4).toString("hex") !== "7f454c46" || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== ({aarch64:183,x86_64:62}[release.architecture])) throw new Error("Release executable has the wrong architecture");
  const {stdout} = await run(executable,["--version"],{timeout:5000});
  if (stdout.trim() !== `Super Space ${release.version}`) throw new Error("Release executable version does not match the requested update");
  await fs.access(path.join(packagePath,"runtime/host.ts")).catch(async error => {
    if (errorCode(error) !== "ENOENT") throw error;
    await fs.access(path.join(packagePath,"runtime/host.mjs"));
  });
  for (const required of ["runtime/bun.lock","scripts/install-linux.sh","scripts/start-daemon.sh"]) await fs.access(path.join(packagePath,required));
  return packagePath;
}

async function writeStatus(value: UpdateStatus): Promise<void> {
  const file = path.join(stateDirectory(), "status.json"), temporary = `${file}.tmp`;
  await fs.mkdir(stateDirectory(), {recursive:true, mode:0o700});
  await fs.writeFile(temporary, JSON.stringify({...value, time:new Date().toISOString()}), {mode:0o600});
  await fs.rename(temporary,file);
}

export async function acquireUpdateLock(directory: string): Promise<FileHandle> {
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const lock = await fs.open(path.join(directory,"install.lock"),"a",0o600);
  try {
    await new Promise<void>((resolve,reject) => {
      // The inherited descriptor shares its lock with this process and releases it even after a crash.
      const child = spawn("flock",["--nonblock","--conflict-exit-code","75","3"],{stdio:["ignore","ignore","pipe",lock.fd]});
      let diagnostic = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (value: string) => { diagnostic = (diagnostic + value).slice(-4096); });
      child.once("error",reject);
      child.once("exit",code => {
        if (code === 0) resolve();
        else reject(new Error(code === 75 ? "Another Super Space update is running" : `Could not lock the update: ${diagnostic.trim() || `flock exited ${code}`}`));
      });
    });
    const legacy = path.join(directory,"lock");
    let owner: unknown;
    try { owner = JSON.parse(await fs.readFile(path.join(legacy,"owner.json"),"utf8")); }
    catch (error) { if (errorCode(error) !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    if (isRecord(owner) && typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
      try { process.kill(owner.pid,0); throw new Error("Another Super Space update is running"); }
      catch (error) { if (errorCode(error) !== "ESRCH") throw error; }
    } else {
      const status = await fs.stat(legacy).catch((error: unknown) => { if (errorCode(error) !== "ENOENT") throw error; });
      if (status && Date.now() - status.mtimeMs < 30000) throw new Error("Another Super Space update is starting; retry in a moment");
    }
    return lock;
  } catch (error) {
    await lock.close();
    throw error;
  }
}

export async function backupInstallation(target: string, previous: string, packagePath: string): Promise<InstallationSnapshot[]> {
  const locations = ["bin","runtime","bundled-extensions"];
  for (const entry of await fs.readdir(path.join(packagePath,"extensions"),{withFileTypes:true})) {
    if (!entry.isDirectory()) continue;
    const manifest: unknown = JSON.parse(await fs.readFile(path.join(packagePath,"extensions",entry.name,"package.json"),"utf8"));
    if (!isRecord(manifest) || typeof manifest.name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(manifest.name)) throw new Error("Release contains an invalid bundled extension ID");
    locations.push(`extensions/${manifest.name}`);
  }
  await fs.rm(previous,{recursive:true,force:true});
  await fs.mkdir(previous,{mode:0o700});
  const snapshot: InstallationSnapshot[] = [];
  for (const location of new Set(locations)) {
    const existed = await fs.stat(path.join(target,location)).then(() => true,(error: unknown) => { if (errorCode(error) !== "ENOENT") throw error; return false; });
    if (existed) await fs.cp(path.join(target,location),path.join(previous,location),{recursive:true});
    snapshot.push({location,existed});
  }
  return snapshot;
}

export async function restoreInstallation(target: string, previous: string, snapshot: readonly InstallationSnapshot[]): Promise<void> {
  for (const {location,existed} of snapshot) {
    await fs.rm(path.join(target,location),{recursive:true,force:true});
    if (existed) await fs.cp(path.join(previous,location),path.join(target,location),{recursive:true});
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export async function install(version: string, current: string, options: CheckOptions = {}): Promise<void> {
  parts(version);
  parts(current);
  const directory = stateDirectory(), target = installDirectory();
  const lock = await acquireUpdateLock(directory);
  let staging: string | undefined;
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
      await run("systemctl",["--user","stop","super-space.service"]).catch(() => {});
      await restoreInstallation(target,previous,snapshot);
      await run("systemctl",["--user","restart","super-space.service"]);
      throw new Error(`Update failed and the previous version was restored: ${errorMessage(error)}`);
    }
    await writeStatus({state:"complete",version});
    await run("notify-send",["--app-name=Super Space",`Updated to Super Space ${version}`]).catch(() => {});
  } catch (error) {
    const message = errorMessage(error);
    await writeStatus({state:"failed",version,message});
    await run("notify-send",["--app-name=Super Space","Super Space update failed",message]).catch(() => {});
    throw error;
  } finally {
    try { if (staging) await fs.rm(staging,{recursive:true,force:true}); }
    finally { await lock.close(); }
  }
}

if (process.argv[1] && fsSync.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const version = process.argv[3];
    if (!version) throw new Error("Usage: updater.ts check CURRENT_VERSION | install VERSION CURRENT_VERSION");
    if (process.argv[2] === "install") {
      const current = process.argv[4];
      if (!current) throw new Error("Installing an update requires the current version");
      await install(version, current);
    } else console.log(JSON.stringify(await check(version)));
  } catch (error) { console.error(errorMessage(error)); process.exitCode = 1; }
}
