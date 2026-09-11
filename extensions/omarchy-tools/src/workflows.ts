import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";

export type WorkflowValues = Record<string, unknown>;

export interface RunOptions {
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

export type Execute = (command: string, args: string[], options?: RunOptions) => Promise<string>;

export interface WorkflowOptions {
  execute?: Execute;
  signal?: AbortSignal;
  home?: string;
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class FieldError extends Error {
  constructor(public field: string, message: string) { super(message); }
}

export function plainText(value: unknown, field: string, label: string, required = true) {
  const text = String(value || "").trim();
  if (required && !text) throw new FieldError(field, `Enter ${label.toLowerCase()}`);
  if (/[\x00-\x1f\x7f]/.test(text)) throw new FieldError(field, `${label} must be a single line`);
  return text;
}

export function appName(value: unknown) {
  const name = plainText(value, "name", "Name");
  if (name.includes("/") || name === "." || name === ".." || Buffer.byteLength(name) > 240) {
    throw new FieldError("name", "Use a name without slashes, under 240 bytes");
  }
  return name;
}

export function httpURL(value: unknown, field = "url", label = "URL") {
  let input = plainText(value, field, label);
  if (!/^[a-z][a-z\d+.-]*:/i.test(input)) input = `https://${input}`;
  let url;
  try { url = new URL(input); } catch { throw new FieldError(field, "Enter a valid website URL"); }
  if (!/^https?:$/.test(url.protocol) || /\s/.test(input)) throw new FieldError(field, "Use an HTTP or HTTPS URL without spaces");
  return url.href;
}

export function iconReference(value: unknown, fallback = "") {
  const icon = plainText(value, "icon", "Icon", false) || fallback;
  return /^https?:/i.test(icon) ? httpURL(icon, "icon", "Icon URL") : icon;
}

export function webAppArguments(values: WorkflowValues): [string, string, string] {
  return [appName(values.name), httpURL(values.url), iconReference(values.icon)];
}

export function tuiArguments(values: WorkflowValues): [string, string, string, string] {
  const style = String(values.style || "float");
  if (!["float", "tile"].includes(style)) throw new FieldError("style", "Choose a window style");
  return [appName(values.name), plainText(values.command, "command", "Command"), style, iconReference(values.icon, "utilities-terminal")];
}

export function reminderArguments(values: WorkflowValues): [string, string] {
  const minutes = String(values.minutes || "").trim();
  if (!/^\d+$/.test(minutes) || Number(minutes) < 1 || Number(minutes) > 525600) {
    throw new FieldError("minutes", "Enter a number of minutes between 1 and 525600");
  }
  return [String(Number(minutes)), plainText(values.message, "message", "Message", false)];
}

export interface ReminderEntry {
  unit: string;
  label: string;
  atTime: string;
  remaining: string;
}

export function parseReminders(output: string): ReminderEntry[] {
  const data: unknown = JSON.parse(output);
  if (!isRecord(data) || !Array.isArray(data.reminders)) throw new Error("Invalid reminder listing");
  return data.reminders.map((reminder: unknown) => {
    if (!isRecord(reminder) || typeof reminder.unit !== "string" || typeof reminder.label !== "string"
      || typeof reminder.atTime !== "string" || typeof reminder.remaining !== "string") throw new Error("Invalid reminder entry");
    return { unit: reminder.unit, label: reminder.label, atTime: reminder.atTime, remaining: reminder.remaining };
  });
}

export async function selectedPaths(value: unknown, { field = "files", directory = false, multiple = true }: { field?: string; directory?: boolean; multiple?: boolean } = {}): Promise<[string, ...string[]]> {
  if (!Array.isArray(value) || !value.length) throw new FieldError(field, directory ? "Choose a folder" : "Choose a file");
  if (!multiple && value.length !== 1) throw new FieldError(field, "Choose one item");
  const paths = [...new Set(value.map(file => path.resolve(String(file))))];
  for (const file of paths) {
    let entry;
    try { entry = await fs.stat(file); } catch { throw new FieldError(field, `Cannot access ${path.basename(file)}`); }
    if (directory ? !entry.isDirectory() : !entry.isFile()) throw new FieldError(field, directory ? "Choose a folder" : "Choose a regular file");
  }
  return paths as [string, ...string[]];
}

const supervisedCommand = `
const {spawn} = require('node:child_process');
const parent = process.ppid;
const {command, args} = JSON.parse(process.argv[1]);
const child = spawn(command, args, {stdio:'inherit'});
const watcher = setInterval(() => {
  if (process.ppid !== parent) process.kill(-process.pid, 'SIGKILL');
}, 200);
child.once('error', error => { console.error(error.code === 'ENOENT' ? command + ' is not installed' : error.message); clearInterval(watcher); process.exitCode = 1; });
child.once('close', code => { clearInterval(watcher); process.exitCode = code ?? 1; });
`;

export function run(command: string, args: string[], { signal, timeout = 120000, env = process.env, input }: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const child = spawn(process.execPath, ["-e", supervisedCommand, JSON.stringify({command, args})],
      { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: true, env });
    let stdout = "", stderr = "", timedOut = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      if (child.pid === undefined) return;
      const group = -child.pid;
      try { process.kill(group, "SIGTERM"); } catch {}
      escalation ||= setTimeout(() => { try { process.kill(group, "SIGKILL"); } catch {} }, 1000);
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeout);
    const abort = () => terminate();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) terminate();
    process.once("exit", terminate);
    child.stdout?.on("data", data => { stdout = (stdout + data).slice(-1048576); });
    child.stderr?.on("data", data => { stderr = (stderr + data).slice(-16384); });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
    const cleanup = () => { clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener("abort", abort); process.removeListener("exit", terminate); };
    child.once("error", error => { cleanup(); reject(hasErrorCode(error, "ENOENT") ? new Error(`${command} is not installed`) : error); });
    child.once("close", code => {
      cleanup();
      if (signal?.aborted) reject(signal.reason || new Error("Canceled"));
      else if (timedOut) reject(new Error(`${command} timed out`));
      else if (code !== 0) reject(new Error((stderr || stdout).trim().split("\n").slice(-3).join("\n") || `${command} failed (${code})`));
      else resolve(stdout.trim());
    });
  });
}

export async function mediaKind(file: string, execute: Execute = run, signal?: AbortSignal) {
  const mime = await execute("file", ["--brief", "--mime-type", "--", file], { signal });
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  throw new FieldError("files", "Choose an image or video");
}

export async function transcodeArguments(values: WorkflowValues, execute: Execute = run, signal?: AbortSignal) {
  const [file] = await selectedPaths(values.files, { multiple: false });
  const kind = await mediaKind(file, execute, signal);
  const formats = kind === "image" ? ["jpg", "png"] : ["mp4", "gif"];
  const resolutions = kind === "image" ? ["high", "medium", "low"] : ["4k", "1080p", "720p"];
  const format = String(values.format || ""), resolution = String(values.resolution || "");
  if (!formats.includes(format)) throw new FieldError("format", `Choose ${formats.join(" or ")} for this ${kind}`);
  if (!resolutions.includes(resolution)) throw new FieldError("resolution", `Choose a ${kind} resolution`);
  const extension = path.extname(file);
  const output = `${file.slice(0, extension ? -extension.length : undefined)}-${resolution}.${format}`;
  try {
    await fs.access(output);
    throw new FieldError("files", `${path.basename(output)} already exists. Rename it before converting again.`);
  } catch (error) { if (!hasErrorCode(error, "ENOENT")) throw error; }
  return { args: ["--", file, format, resolution], output };
}

export function desktopPath(name: unknown, home = os.homedir()) {
  return path.join(home, ".local/share/applications", `${appName(name)}.desktop`);
}

export async function pathExists(file: string) {
  try { await fs.access(file); return true; } catch (error) { if (hasErrorCode(error, "ENOENT")) return false; throw error; }
}

export async function brandingArguments(values: WorkflowValues, target: string, home = os.homedir()) {
  const [file] = await selectedPaths(values.files, { multiple: false });
  if (![".png", ".svg"].includes(path.extname(file).toLowerCase())) throw new FieldError("files", "Choose a PNG or SVG image");
  if (!["about", "screensaver"].includes(target)) throw new Error("Unknown branding target");
  return [file, path.join(home, ".config/omarchy/branding", `${target}.txt`), "--width", target === "about" ? "54" : "80", "--height", "26"];
}

export async function installWallpapers(values: WorkflowValues, { execute = run, signal, home = os.homedir() }: WorkflowOptions = {}) {
  const files = await selectedPaths(values.files);
  for (const file of files) if (await mediaKind(file, execute, signal) !== "image") throw new FieldError("files", "Choose images for wallpapers");
  const theme = (await fs.readFile(path.join(home, ".local/state/omarchy/current/theme.name"), "utf8")).trim();
  if (!theme || theme.includes("/") || theme === "." || theme === "..") throw new Error("The current Omarchy theme is not valid");
  const destination = path.join(home, ".config/omarchy/backgrounds", theme);
  await fs.mkdir(destination, { recursive: true });
  const installed: string[] = [];
  try {
    for (const file of files) {
      signal?.throwIfAborted();
      const parsed = path.parse(file);
      for (let index = 0; ; index++) {
        const output = path.join(destination, `${parsed.name}${index ? `-${index}` : ""}${parsed.ext}`);
        try { await fs.copyFile(file, output, constants.COPYFILE_EXCL); installed.push(output); break; }
        catch (error) { if (!hasErrorCode(error, "EEXIST")) throw error; }
      }
    }
  } catch (error) { await Promise.all(installed.map(file => fs.rm(file, { force: true }))); throw error; }
  if (values.apply && installed[0]) await execute("omarchy-theme-bg-set", [installed[0]], { signal });
  return installed;
}

export function themeName(repository: unknown) {
  let location = plainText(repository, "repository", "Repository");
  if (!location.includes("://") && location.includes(":") && !location.split(":", 1)[0].includes("/")) location = location.slice(location.indexOf(":") + 1);
  const name = path.posix.basename(location.replace(/\/+$/, ""), ".git").replace(/^omarchy-/, "").replace(/-theme$/, "").toLowerCase();
  if (!/^[a-z0-9_][a-z0-9._+-]*$/.test(name)) throw new FieldError("repository", "The repository must have a valid theme name");
  return name;
}

export async function installTheme(values: WorkflowValues, { execute = run, signal, home = os.homedir() }: WorkflowOptions = {}) {
  const repository = plainText(values.repository, "repository", "Repository");
  await execute("omarchy-git-url-check", [repository], { signal });
  const name = themeName(repository);
  if (await pathExists(path.join(home, ".config/omarchy/themes", name))) throw new FieldError("repository", `${name} is already installed`);
  await execute("omarchy-theme-install", [repository], { signal, timeout: 300000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -oBatchMode=yes" } });
}

export async function addShellPlugin(values: WorkflowValues, { execute = run, signal }: WorkflowOptions = {}) {
  const repository = plainText(values.repository, "repository", "Repository");
  const section = String(values.section || "default");
  if (!["default", "left", "center", "right"].includes(section)) throw new FieldError("section", "Choose a bar section");
  await execute("omarchy-git-url-check", [repository], { signal });
  const output = await execute("omarchy-plugin-add", [repository, "--yes"], { signal, timeout: 300000 });
  if (!values.enable) return;
  const id = output.match(/^Added ([^\s/]+) into /m)?.[1];
  if (!id) throw new Error("Plugin added. Enable it from Setup → Shell → Plugins.");
  for (let attempt = 0; attempt < 40; attempt++) {
    signal?.throwIfAborted();
    const catalog: unknown = JSON.parse(await execute("omarchy-plugin-catalog", [], { signal }));
    if (!Array.isArray(catalog)) throw new Error("The shell plugin catalog is not valid");
    const plugin = catalog.find((plugin: unknown): plugin is Record<string, unknown> => isRecord(plugin) && plugin.id === id);
    if (plugin) {
      const kinds = Array.isArray(plugin.kinds) ? plugin.kinds : [];
      const placement = section !== "default" && !kinds.includes("bar") && kinds.includes("bar-widget") ? ["--section", section] : [];
      await execute("omarchy-plugin-enable", [id, ...placement], { signal });
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Plugin added. The shell has not discovered it yet; enable it from Setup → Shell → Plugins.");
}

export function retroCores(output: unknown) {
  return String(output).split("\n").flatMap(line => {
    const match = line.trim().match(/^(.+) \(([a-zA-Z0-9_+-]+)\)$/);
    return match ? [{ title: match[1], id: match[2] }] : [];
  });
}

export async function retroGameArguments(values: WorkflowValues, execute: Execute = run, signal?: AbortSignal) {
  const [file] = await selectedPaths(values.files, { multiple: false });
  if (/["`$\\%\x00-\x1f\x7f]/.test(file)) throw new FieldError("files", "Rename this file without quotes, backslashes, dollar signs, backticks, or percent signs");
  const cores = retroCores(await execute("omarchy-games-retro-cores", [], { signal }));
  if (!cores.some(core => core.id === values.core)) throw new FieldError("core", "Choose an installed RetroArch core");
  return [String(values.core), file];
}
