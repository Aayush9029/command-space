import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {browserDirectory} from "./browser.ts";
import {currentUserId, errorMessage, isRecord} from "./adapter-utils.ts";

const directory = browserDirectory();
fs.mkdirSync(directory, {recursive: true, mode: 0o700});
const stat = fs.lstatSync(directory);
if (!stat.isDirectory() || stat.uid !== currentUserId() || (stat.mode & 0o077)) throw new Error("Browser socket directory must be private and owned by the current user");
const socketPath = path.join(directory, `${process.pid}.sock`);
let sequence = 0;
const pending = new Map<string, net.Socket>(), clients = new Set<net.Socket>();
function send(message: Record<string, unknown>): void {
  const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
  if (body.length > 1024 * 1024) throw new Error("Browser request too large");
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}

const server = net.createServer(socket => {
  clients.add(socket);
  let request = Buffer.alloc(0), requestId: string | undefined;
  const timeout = setTimeout(() => {
    if (requestId) pending.delete(requestId);
    socket.end(`${JSON.stringify({error: "Browser request timed out"})}\n`);
  }, 12000);
  socket.on("error", () => socket.destroy());
  socket.on("close", () => { clearTimeout(timeout); clients.delete(socket); if (requestId) pending.delete(requestId); });
  socket.on("data", (chunk: Buffer) => {
    if (requestId) return;
    if (request.length + chunk.length > 65536) return socket.destroy();
    request = Buffer.concat([request, chunk]);
    if (!request.includes(10)) return;
    try {
      const value: unknown = JSON.parse(request.toString("utf8"));
      if (!isRecord(value) || !["getTabs", "getContent"].includes(String(value.method))) throw new Error("Unknown browser method");
      if (value.options !== undefined && !isRecord(value.options)) throw new Error("Invalid browser request options");
      requestId = String(++sequence);
      pending.set(requestId, socket);
      send({method: value.method, options: value.options, id: requestId});
    } catch (error) { socket.end(`${JSON.stringify({error: errorMessage(error)})}\n`); }
  });
});
server.maxConnections = 64;
server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o600); send({type: "ready"}); });
server.on("error", error => { console.error(error.message); shutdown(1); });

const header = Buffer.alloc(4);
let headerSize = 0, bodyLength = 0, bodySize = 0;
let bodyChunks: Buffer[] = [];
function receive(body: Buffer): void {
  let message: unknown;
  try { message = JSON.parse(body.toString("utf8")); }
  catch { return shutdown(1); }
  if (!isRecord(message)) return shutdown(1);
  if (message.type === "focused") {
    try { fs.utimesSync(socketPath, new Date(), new Date()); } catch {}
  } else if (typeof message.id === "string") {
    const socket = pending.get(message.id);
    if (socket) {
      pending.delete(message.id);
      socket.end(`${JSON.stringify({result: message.result, error: message.error})}\n`);
    }
  }
}
process.stdin.on("data", (chunk: Buffer) => {
  let offset = 0;
  while (offset < chunk.length) {
    if (headerSize < 4) {
      const count = Math.min(4 - headerSize, chunk.length - offset);
      chunk.copy(header, headerSize, offset, offset + count);
      offset += count; headerSize += count;
      if (headerSize < 4) continue;
      bodyLength = header.readUInt32LE(0);
      if (bodyLength === 0 || bodyLength > 20 * 1024 * 1024) return shutdown(1);
    }
    const count = Math.min(bodyLength - bodySize, chunk.length - offset);
    if (count) bodyChunks.push(chunk.subarray(offset, offset + count));
    offset += count; bodySize += count;
    if (bodySize === bodyLength) {
      receive(Buffer.concat(bodyChunks, bodyLength));
      headerSize = 0; bodySize = 0; bodyChunks = [];
    }
  }
});
function shutdown(code = 0): never {
  for (const socket of clients) socket.destroy();
  server.close();
  try { fs.unlinkSync(socketPath); } catch {}
  process.exit(code);
}
process.stdin.on("end", () => shutdown(headerSize || bodySize ? 1 : 0));
process.stdin.on("error", () => shutdown(1));
process.stdout.on("error", () => shutdown(1));
process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());
