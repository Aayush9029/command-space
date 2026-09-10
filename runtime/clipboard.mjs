import {spawn, execFile} from "node:child_process";
import {promisify} from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const execute = promisify(execFile);
const bridge = () => globalThis.__commandSpace;
const run = async (program, args) => (await execute(program,args,{encoding:"utf8",timeout:5000,maxBuffer:16*1024*1024})).stdout;

async function readMime(type) {
  try { return await run("wl-paste",["--no-newline","--type",type]); }
  catch (error) { if (error.code === 1) return undefined; throw error; }
}

function copy(content, options = {}) {
  let value = typeof content === "string" || typeof content === "number" ? {text:String(content)} : {...content};
  if (value.file instanceof URL) value.file = fileURLToPath(value.file);
  if (Buffer.isBuffer(value.file)) value.file = value.file.toString();
  if (![value.text,value.html,value.file].some(v => typeof v === "string")) return Promise.reject(new Error("Unsupported clipboard content"));
  value = {...value,concealed:Boolean(options.concealed)};
  return new Promise((resolve,reject) => {
    const child = spawn(bridge().launcherPath,["clipboard-serve"],{detached:true,stdio:["pipe","pipe","pipe"]});
    let stderr = "", stdout = "", settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.stdout.destroy(); child.stderr.destroy();
      if (error) { child.kill(); reject(error); } else { child.unref(); resolve(); }
    };
    const timer = setTimeout(() => finish(new Error("Clipboard copy timed out")),5000);
    child.on("error",finish);
    child.stdin.on("error",finish);
    child.stderr.on("data",chunk => {stderr += chunk.toString().slice(0,2048);});
    child.stdout.on("data",chunk => {stdout += chunk; if (stdout.includes("ready\n")) finish();});
    child.on("exit",code => { if (!settled) finish(new Error(stderr || `Clipboard helper exited ${code}`)); });
    child.stdin.end(JSON.stringify(value));
  });
}

async function read(options = {}) {
  const offset = options.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > 5) throw new Error("Clipboard offset must be an integer between 0 and 5");
  if (offset) {
    let history;
    try { history = JSON.parse(await fs.readFile(path.join(process.env.XDG_STATE_HOME || path.join(process.env.HOME,".local/state"),"omarchy/clipboard-history.json"),"utf8")); }
    catch (error) { if (error.code === "ENOENT") return {}; throw error; }
    const item = history[offset];
    if (typeof item === "string") return {text:item};
    if (item?.type === "text") return {text:item.text};
    if (item?.path) return {file:item.path};
    return {};
  }
  const types = (await run("wl-paste",["--list-types"]).catch(error => {if (error.code === 1) return ""; throw error;})).split("\n");
  const result = {};
  if (types.some(type => type.startsWith("text/plain") || ["UTF8_STRING","STRING"].includes(type))) result.text = await readMime("text");
  if (types.includes("text/html")) result.html = await readMime("text/html");
  if (types.includes("text/uri-list")) {
    const uri = (await readMime("text/uri-list"))?.split(/\r?\n/).find(line => line && !line.startsWith("#"));
    if (uri?.startsWith("file:")) result.file = fileURLToPath(uri);
  }
  return result;
}

export const Clipboard = {
  copy, read,
  async readText(options) { return (await read(options)).text; },
  async clear() { await run("wl-copy",["--clear"]); },
  async paste(content) {
    await copy(content); bridge().emit({type:"close"});
    await new Promise(resolve => setTimeout(resolve,150));
    await run(bridge().launcherPath,["paste"]);
  },
};
