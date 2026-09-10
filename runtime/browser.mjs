import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export function browserDirectory() {
  return path.join(process.env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `command-space-${process.getuid()}`), "command-space-browser");
}

function connections() {
  const directory = browserDirectory();
  try {
    const owner = fs.lstatSync(directory);
    if (!owner.isDirectory() || owner.uid !== process.getuid() || (owner.mode & 0o077)) return [];
    return fs.readdirSync(directory).filter(name => /^\d+\.sock$/.test(name)).flatMap(name => {
      try {
        const socket = path.join(directory, name), stat = fs.lstatSync(socket);
        process.kill(Number(name.split(".")[0]), 0);
        return stat.isSocket() && stat.uid === process.getuid() ? [{socket, modified:stat.mtimeMs}] : [];
      } catch { return []; }
    }).sort((a, b) => b.modified - a.modified);
  } catch { return []; }
}

export function browserAvailable() { return connections().length > 0; }

export async function browserRequest(method, options = {}) {
  const connection = connections()[0];
  if (!connection) throw new Error("Connect the Command Space browser extension to use browser commands");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(connection.socket);
    const chunks = [];
    let size = 0;
    const finish = (error, result) => { socket.destroy(); error ? reject(error) : resolve(result); };
    socket.setTimeout(15000, () => finish(new Error("The browser did not respond in time")));
    socket.on("error", error => finish(new Error(`Browser connection: ${error.message}`)));
    socket.on("connect", () => socket.write(`${JSON.stringify({method, options})}\n`));
    socket.on("data", chunk => {
      size += chunk.length;
      if (size > 20 * 1024 * 1024) return finish(new Error("Browser response exceeds 20 MiB"));
      chunks.push(chunk);
      if (chunk.includes(10)) {
        try {
          const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          finish(response.error ? new Error(response.error) : null, response.result);
        } catch (error) { finish(error); }
      }
    });
    socket.on("end", () => finish(new Error("Browser disconnected before responding")));
  });
}

export const BrowserExtension = {
  __commandSpaceCapability:"browser",
  getTabs() { return browserRequest("getTabs"); },
  getContent(options = {}) {
    const format = options.format || "markdown";
    if (!["html", "text", "markdown"].includes(format)) return Promise.reject(new Error(`Unknown content format: ${format}`));
    if (options.cssSelector && format === "markdown") return Promise.reject(new Error("cssSelector cannot be used with markdown content"));
    if (options.tabId !== undefined && !Number.isInteger(options.tabId)) return Promise.reject(new Error("tabId must be an integer"));
    return browserRequest("getContent", {...options, format});
  },
};
