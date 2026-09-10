import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { browserDirectory } from "./browser.mjs";

const directory = browserDirectory();
fs.mkdirSync(directory, {recursive:true, mode:0o700});
const stat = fs.lstatSync(directory);
if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error("Browser socket directory must be private and owned by the current user");
const socketPath = path.join(directory, `${process.pid}.sock`);
let sequence = 0, input = Buffer.alloc(0);
const pending = new Map(), clients = new Set();
function send(message) {
  const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
  if (body.length > 1024 * 1024) throw new Error("Browser request too large");
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}

const server = net.createServer(socket => {
  clients.add(socket);
  let request = Buffer.alloc(0), requestId;
  socket.setTimeout(12000, () => socket.end(`${JSON.stringify({error:"Browser request timed out"})}\n`));
  socket.on("error", () => socket.destroy());
  socket.on("close", () => { clients.delete(socket); pending.delete(requestId); });
  socket.on("data", chunk => {
    if (requestId) return;
    request = Buffer.concat([request, chunk]);
    if (request.length > 65536) return socket.destroy();
    if (!request.includes(10)) return;
    try {
      const value = JSON.parse(request.toString("utf8"));
      if (!["getTabs", "getContent"].includes(value.method)) throw new Error("Unknown browser method");
      requestId = String(++sequence);
      pending.set(requestId, socket);
      send({...value, id:requestId});
    } catch (error) { socket.end(`${JSON.stringify({error:error.message})}\n`); }
  });
});
server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o600); send({type:"ready"}); });
server.on("error", error => { console.error(error.message); shutdown(1); });

process.stdin.on("data", chunk => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (length > 20 * 1024 * 1024) return shutdown(1);
    if (input.length < 4 + length) return;
    let message;
    try { message = JSON.parse(input.subarray(4, 4 + length).toString("utf8")); }
    catch { return shutdown(1); }
    input = input.subarray(4 + length);
    if (message.type === "focused") {
      try { fs.utimesSync(socketPath, new Date(), new Date()); } catch {}
    } else {
      const socket = pending.get(message.id);
      if (socket) { pending.delete(message.id); socket.end(`${JSON.stringify({result:message.result, error:message.error})}\n`); }
    }
  }
});
function shutdown(code = 0) {
  for (const socket of clients) socket.destroy();
  server.close();
  try { fs.unlinkSync(socketPath); } catch {}
  process.exit(code);
}
process.stdin.on("end", () => shutdown());
process.stdout.on("error", () => shutdown(1));
process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());
