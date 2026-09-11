import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {currentUserId, isRecord} from "./adapter-utils.ts";

export interface BrowserContentOptions {
  format?: "html" | "text" | "markdown";
  cssSelector?: string;
  tabId?: number;
}
export interface BrowserTab {
  id: number;
  url: string;
  active: boolean;
  title?: string;
  favicon?: string;
}

export function browserDirectory(): string {
  return path.join(process.env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `super-space-${currentUserId()}`), "super-space-browser");
}

function connections(): {socket: string; modified: number}[] {
  const directory = browserDirectory();
  try {
    const uid = currentUserId(), owner = fs.lstatSync(directory);
    if (!owner.isDirectory() || owner.uid !== uid || (owner.mode & 0o077)) return [];
    return fs.readdirSync(directory).filter(name => /^\d+\.sock$/.test(name)).flatMap(name => {
      try {
        const socket = path.join(directory, name), stat = fs.lstatSync(socket);
        process.kill(Number(name.split(".")[0]), 0);
        return stat.isSocket() && stat.uid === uid ? [{socket, modified: stat.mtimeMs}] : [];
      } catch { return []; }
    }).sort((a, b) => b.modified - a.modified);
  } catch { return []; }
}

export function browserAvailable(): boolean { return connections().length > 0; }

export async function browserRequest(method: string, options: BrowserContentOptions = {}): Promise<unknown> {
  const connection = connections()[0];
  if (!connection) throw new Error("Connect the Super Space browser extension to use browser commands");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(connection.socket);
    const chunks: Buffer[] = [];
    let size = 0, settled = false;
    const finish = (error?: unknown, result?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("The browser did not respond in time")), 15000);
    socket.on("error", error => finish(new Error(`Browser connection: ${error.message}`)));
    socket.on("connect", () => socket.write(`${JSON.stringify({method, options})}\n`));
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 20 * 1024 * 1024) return finish(new Error("Browser response exceeds 20 MiB"));
      chunks.push(chunk);
      if (chunk.includes(10)) {
        try {
          const response: unknown = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
          if (!isRecord(response) || (response.error !== undefined && typeof response.error !== "string") || (!Object.hasOwn(response, "result") && !response.error)) throw new Error("Invalid browser response");
          finish(response.error ? new Error(String(response.error)) : undefined, response.result);
        } catch (error) { finish(error); }
      }
    });
    socket.on("end", () => finish(new Error("Browser disconnected before responding")));
  });
}

export const BrowserExtension = {
  __superSpaceCapability: "browser",
  async getTabs(): Promise<BrowserTab[]> {
    const value = await browserRequest("getTabs");
    if (!Array.isArray(value)) throw new Error("Invalid browser tabs response");
    return value.map((tab: unknown) => {
      if (!isRecord(tab) || typeof tab.id !== "number" || !Number.isInteger(tab.id) || typeof tab.url !== "string" || typeof tab.active !== "boolean" || (tab.title !== undefined && typeof tab.title !== "string") || (tab.favicon !== undefined && typeof tab.favicon !== "string")) throw new Error("Invalid browser tab response");
      return {id: tab.id, url: tab.url, active: tab.active, ...(typeof tab.title === "string" ? {title: tab.title} : {}), ...(typeof tab.favicon === "string" ? {favicon: tab.favicon} : {})};
    });
  },
  async getContent(options: BrowserContentOptions = {}): Promise<string> {
    const format = options.format || "markdown";
    if (!["html", "text", "markdown"].includes(format)) throw new Error(`Unknown content format: ${format}`);
    if (options.cssSelector && format === "markdown") throw new Error("cssSelector cannot be used with markdown content");
    if (options.tabId !== undefined && !Number.isInteger(options.tabId)) throw new Error("tabId must be an integer");
    const content = await browserRequest("getContent", {...options, format});
    if (typeof content !== "string") throw new Error("Invalid browser content response");
    return content;
  },
};
