import {spawn} from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {hasErrorCode, isRecord, runDesktopCommand} from "./adapter-utils.ts";
import {getRuntimeContext} from "./types.ts";

export interface ClipboardReadOptions { offset?: number }
export interface ClipboardCopyOptions { concealed?: boolean }
export interface ClipboardContent { text?: string; html?: string; file?: string }
export type ClipboardCopyContent = string | number | (Omit<ClipboardContent, "file"> & {file?: string | URL | Buffer});
const run = (program: string, args: string[]) => runDesktopCommand(program, args, 16 * 1024 * 1024);

async function readMime(type: string): Promise<string | undefined> {
  try { return await run("wl-paste", ["--no-newline", "--type", type]); }
  catch (error) { if (hasErrorCode(error, 1)) return undefined; throw error; }
}

async function copy(content: ClipboardCopyContent, options: ClipboardCopyOptions = {}): Promise<void> {
  const value = typeof content === "string" || typeof content === "number" ? {text: String(content)} : {...content};
  if (value.file instanceof URL) value.file = fileURLToPath(value.file);
  if (Buffer.isBuffer(value.file)) value.file = value.file.toString();
  if (![value.text, value.html, value.file].some(item => typeof item === "string")) throw new Error("Unsupported clipboard content");
  const launcherPath = getRuntimeContext().launcherPath;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launcherPath, ["clipboard-serve"], {detached: true, stdio: ["pipe", "pipe", "pipe"]});
    let stderr = "", stdout = "", settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy(); child.stderr.destroy();
      if (error) { child.kill(); reject(error); } else { child.unref(); resolve(); }
    };
    const timer = setTimeout(() => finish(new Error("Clipboard copy timed out")), 5000);
    child.on("error", finish);
    child.stdin.on("error", finish);
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString().slice(0, Math.max(0, 2048 - stderr.length)); });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.split("\n").includes("ready")) finish();
      else if (stdout.length > 4096) finish(new Error("Invalid clipboard helper response"));
    });
    child.on("exit", code => { if (!settled) finish(new Error(stderr || `Clipboard helper exited ${code}`)); });
    child.stdin.end(JSON.stringify({...value, concealed: Boolean(options.concealed)}));
  });
}

async function read(options: ClipboardReadOptions = {}): Promise<ClipboardContent> {
  const offset = options.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > 5) throw new Error("Clipboard offset must be an integer between 0 and 5");
  if (offset) {
    let history: unknown;
    try { history = JSON.parse(await fs.readFile(path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "omarchy/clipboard-history.json"), "utf8")); }
    catch (error) { if (hasErrorCode(error, "ENOENT")) return {}; throw error; }
    if (!Array.isArray(history)) throw new Error("Invalid clipboard history: expected a list");
    const item: unknown = history[offset];
    if (typeof item === "string") return {text: item};
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") return {text: item.text};
    if (isRecord(item) && typeof item.path === "string") return {file: item.path};
    return {};
  }
  const types = (await run("wl-paste", ["--list-types"]).catch(error => { if (hasErrorCode(error, 1)) return ""; throw error; })).split("\n");
  const result: ClipboardContent = {};
  if (types.some(type => type.startsWith("text/plain") || ["UTF8_STRING", "STRING"].includes(type))) result.text = await readMime("text");
  if (types.includes("text/html")) result.html = await readMime("text/html");
  if (types.includes("text/uri-list")) {
    const uri = (await readMime("text/uri-list"))?.split(/\r?\n/).find(line => line && !line.startsWith("#"));
    if (uri?.startsWith("file:")) result.file = fileURLToPath(uri);
  }
  return result;
}

export const Clipboard = {
  copy, read,
  async readText(options?: ClipboardReadOptions) { return (await read(options)).text; },
  async clear() { await run("wl-copy", ["--clear"]); },
  async paste(content: ClipboardCopyContent) {
    await copy(content); getRuntimeContext().emit({type: "close"});
    await new Promise(resolve => setTimeout(resolve, 150));
    await run(getRuntimeContext().launcherPath, ["paste"]);
  },
};
