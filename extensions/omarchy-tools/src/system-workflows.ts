import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { FieldError, isRecord, plainText, run, type Execute, type WorkflowOptions, type WorkflowValues } from "./workflows.ts";

export function dnsServers(value: unknown) {
  const text = plainText(value, "servers", "DNS servers");
  const servers = [...new Set(text.split(/[\s,]+/).filter(Boolean))];
  if (!servers.length || servers.length > 16) throw new FieldError("servers", "Enter between 1 and 16 DNS server addresses");
  for (const server of servers) {
    const address = server.replace(/^dns\+(?:tls|udp):\/\//, "").split("#", 1)[0].replace(/^\[|\]$/g, "");
    const domain = server.includes("#") ? server.slice(server.indexOf("#") + 1) : "";
    if (!net.isIP(address) || server.includes("#") && !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(domain)) {
      throw new FieldError("servers", `Invalid DNS address: ${server}`);
    }
    if (!/^(?:dns\+(?:tls|udp):\/\/)?[a-zA-Z0-9:.\[\]-]+(?:#[a-zA-Z0-9.-]+)?$/.test(server)) throw new FieldError("servers", "Use IP addresses, optionally followed by #hostname");
  }
  return servers.join(" ");
}

export async function configureDNS(values: WorkflowValues, { execute = run, signal }: WorkflowOptions = {}) {
  return execute("omarchy-dns", ["Custom"], { signal, input: `${dnsServers(values.servers)}\n` });
}

export async function sshKeys(values: WorkflowValues, { execute = run, signal, fetcher = fetch }: WorkflowOptions & { fetcher?: (url: string, options?: RequestInit) => Promise<Response> } = {}) {
  let keys;
  if (values.source === "github") {
    const username = plainText(values.username, "username", "GitHub username");
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(username)) throw new FieldError("username", "Enter a GitHub username");
    const response = await fetcher(`https://github.com/${username}.keys`, { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]) });
    if (!response.ok) throw new FieldError("username", `Could not retrieve keys for ${username}`);
    if (!response.body) throw new FieldError("username", "GitHub did not return a key list");
    const reader = response.body.getReader();
    let text = "", size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) { await reader.cancel(); throw new FieldError("username", "The GitHub key list is too large"); }
      text += Buffer.from(value).toString("utf8");
    }
    keys = text.split(/\r?\n/).map(key => key.trim()).filter(Boolean);
  } else keys = String(values.key || "").split(/\r?\n/).map(key => key.trim()).filter(Boolean);
  keys = [...new Set(keys)];
  const field = values.source === "github" ? "username" : "key";
  if (!keys.length || keys.length > 32) throw new FieldError(field, "Provide between 1 and 32 SSH public keys");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "super-space-public-key-"));
  try {
    const file = path.join(directory, "key.pub");
    for (const key of keys) {
      if (key.length > 16384 || !/^(?:ssh-|ecdsa-|sk-)[^\s]+ [a-zA-Z0-9+/]+={0,3}(?: [^\x00-\x1f\x7f]*)?$/.test(key)) throw new FieldError(field, "Enter a valid SSH public key");
      await fs.writeFile(file, `${key}\n`, { mode: 0o600 });
      try { await execute("ssh-keygen", ["-lf", file], { signal }); }
      catch { throw new FieldError(field, "The SSH public key could not be validated"); }
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
  return keys;
}

export function windowsConfiguration(values: WorkflowValues, resources = { ram: Math.floor(os.totalmem() / 1073741824), cores: os.availableParallelism() }) {
  const ram = String(values.ram || "4G"), disk = String(values.disk || "64G"), cores = String(values.cores || "2");
  if (!/^(?:2|4|8|16|32|64)G$/.test(ram) || Number.parseInt(ram) > resources.ram) throw new FieldError("ram", "Choose RAM available on this machine");
  if (!/^[0-9]{1,2}$/.test(cores) || Number(cores) < 1 || Number(cores) > resources.cores) throw new FieldError("cores", `Enter between 1 and ${resources.cores} CPU cores`);
  if (!/^(?:32|64|128|256|512)G$/.test(disk)) throw new FieldError("disk", "Choose a supported disk size");
  const username = String(values.username || "docker");
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(username)) throw new FieldError("username", "Use up to 20 letters, numbers, hyphens, or underscores");
  const password = String(values.password || "");
  if (!password || [...password].length > 64 || /[\x00-\x1f\x7f]/.test(password)) throw new FieldError("password", "Enter a password of 1–64 printable characters");
  return { ram, disk, cores: String(Number(cores)), username, password };
}

export interface EncryptedDrive {
  path: string;
  title: string;
}

export function encryptedDrives(output: string): EncryptedDrive[] {
  const data: unknown = JSON.parse(output);
  if (!isRecord(data) || !Array.isArray(data.blockdevices)) throw new Error("Invalid encrypted drive listing");
  const pending: unknown[] = [...data.blockdevices].reverse();
  const result: EncryptedDrive[] = [];
  while (pending.length) {
    const device = pending.pop();
    if (!isRecord(device)) continue;
    if (Array.isArray(device.children)) pending.push(...[...device.children].reverse());
    const devicePath = typeof device.path === "string" ? device.path : device.name;
    if (device.fstype !== "crypto_LUKS" || typeof devicePath !== "string" || !devicePath.startsWith("/dev/")) continue;
    const title = [devicePath, device.size, device.label || device.model].filter(value => typeof value === "string" && value).join(" · ");
    result.push({ path: devicePath, title });
  }
  return result;
}

export async function discoverEncryptedDrives(execute: Execute = run, signal?: AbortSignal) {
  return encryptedDrives(await execute("lsblk", ["--json", "--paths", "--output", "NAME,PATH,FSTYPE,SIZE,LABEL,MODEL"], { signal }));
}

export async function drivePassword(values: WorkflowValues, { execute = run, signal }: WorkflowOptions = {}) {
  const drive = String(values.drive || "");
  if (!(await discoverEncryptedDrives(execute, signal)).some(item => item.path === drive)) throw new FieldError("drive", "Choose an encrypted drive");
  const password = String(values.password || "");
  if (!password || /[\x00-\x1f\x7f]/.test(password)) throw new FieldError("password", "Enter a nonempty passphrase on one line");
  if (password !== values.confirmation) throw new FieldError("confirmation", "Passphrases do not match");
  return { drive, password };
}

export interface OperationValues {
  sshd: { keys: string[] };
  windows: ReturnType<typeof windowsConfiguration>;
  "drive-password": { drive: string; password: string };
}

export type SystemOperation = {
  [Kind in keyof OperationValues]: { operation: Kind; values: OperationValues[Kind] }
}[keyof OperationValues];

export function parseOperation(value: unknown): SystemOperation {
  if (!isRecord(value) || !isRecord(value.values)) throw new Error("Invalid operation data");
  const values = value.values;
  switch (value.operation) {
    case "sshd":
      if (!Array.isArray(values.keys) || !values.keys.every((key: unknown) => typeof key === "string")) throw new Error("Invalid SSH operation data");
      return { operation: "sshd", values: { keys: values.keys } };
    case "windows":
      return { operation: "windows", values: windowsConfiguration(values) };
    case "drive-password":
      if (typeof values.drive !== "string" || typeof values.password !== "string") throw new Error("Invalid drive operation data");
      return { operation: "drive-password", values: { drive: values.drive, password: values.password } };
    default:
      throw new Error("Unknown operation");
  }
}

export async function launchTerminalOperation<Kind extends keyof OperationValues>(operation: Kind, values: OperationValues[Kind], { assetsPath, execute = run, signal }: WorkflowOptions & { assetsPath: string }) {
  if (!["sshd", "windows", "drive-password"].includes(operation)) throw new Error("Unknown system operation");
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "super-space-operation-"));
  const payload = path.join(folder, "operation.json");
  try {
    await fs.chmod(folder, 0o700);
    await fs.writeFile(payload, JSON.stringify({ operation, values }), { mode: 0o600 });
    const helper = path.join(assetsPath, "native-operation.ts");
    await fs.access(helper);
    await execute("systemd-run", ["--user", "--quiet", "--collect", `--unit=super-space-operation-${randomUUID()}`,
      "--", "xdg-terminal-exec", "--app-id=org.superspace.authentication", "--title=Super Space",
      "-e", process.execPath, helper, payload], { signal });
  } catch (error) { await fs.rm(folder, { recursive: true, force: true }); throw error; }
  return payload;
}

export async function consumeOperation(file: string): Promise<SystemOperation> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let operation: SystemOperation;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0 || metadata.size > 131072) throw new Error("Invalid operation data");
    operation = parseOperation(JSON.parse(await handle.readFile("utf8")));
  } finally { await handle.close(); }
  await fs.unlink(file);
  await fs.rmdir(path.dirname(file));
  return operation;
}
