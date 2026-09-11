import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { errorMessage, hasErrorCode, inputMessage, isRecord, outputMessage, protocolLines, renderTree, type LaunchMessage, type RenderNode, type WireMessage } from "./protocol.ts";

const invocation = fileURLToPath(new URL("./invocation.ts", import.meta.url));
const emit = (message: WireMessage): void => { process.stdout.write(`${JSON.stringify(message)}\n`); };
const report = (error: unknown): void => emit({ type: "error", message: errorMessage(error) });
const MAX_QUEUED_LAUNCHES = 64;
const MAX_PENDING_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_INPUT_MESSAGES = 256;
interface Worker {
  child: ChildProcessWithoutNullStreams;
  prefix: string;
  background: boolean;
  ready: boolean;
  terminating: boolean;
  pendingInputBytes: number;
  pendingInputMessages: number;
  closed: Promise<void>;
}
let active: Worker | undefined;
let generation = 0;
let launching = false;
let stopping = false;
const queue: LaunchMessage[] = [];

function callbacks(value: unknown, prefix: string, depth = 0): unknown {
  if (depth > 256) throw new Error("Extension render properties are too deeply nested");
  if (Array.isArray(value)) return value.map(item => callbacks(item, prefix, depth + 1));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === "$callback") {
      if (typeof item !== "string") throw new Error("Invalid extension render callback");
      return [key, `${prefix}${item}`];
    }
    return [key, callbacks(item, prefix, depth + 1)];
  }));
}

function tree(nodes: RenderNode[], prefix: string): RenderNode[] {
  return nodes.map(node => ({ ...node, id: `${prefix}${node.id}`, props: Object.fromEntries(Object.entries(node.props).map(([key, value]) => [key, callbacks(value, prefix)])), children: tree(node.children, prefix) }));
}

function killGroup(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (!hasErrorCode(error, "ESRCH")) report(error); }
}

function terminate(worker: Worker | undefined): Promise<void> {
  if (!worker) return Promise.resolve();
  worker.terminating = true;
  killGroup(worker.child);
  return worker.closed;
}

function fail(worker: Worker, error: unknown): void {
  if (worker.terminating) return;
  report(error);
  terminate(worker).then(() => {
    if (active === worker) { active = undefined; return advance(); }
  }).catch(report);
}

function write(worker: Worker, message: WireMessage): void {
  if (worker.terminating) return;
  const line = `${JSON.stringify(message)}\n`;
  const bytes = Buffer.byteLength(line);
  if (worker.pendingInputBytes + bytes > MAX_PENDING_INPUT_BYTES || worker.pendingInputMessages >= MAX_PENDING_INPUT_MESSAGES) {
    fail(worker, new Error("Extension invocation input backlog exceeded"));
    return;
  }
  worker.pendingInputBytes += bytes;
  worker.pendingInputMessages += 1;
  // Keep control messages readable while the bounded worker pipe is blocked.
  try {
    worker.child.stdin.write(line, error => {
      worker.pendingInputBytes -= bytes;
      worker.pendingInputMessages -= 1;
      if (error) fail(worker, error);
    });
  } catch (error) {
    worker.pendingInputBytes -= bytes;
    worker.pendingInputMessages -= 1;
    fail(worker, error);
  }
}

async function advance(): Promise<void> {
  if (launching || stopping || !queue.length || (active && !active.ready)) return;
  launching = true;
  try {
    const previous = active;
    active = undefined;
    await terminate(previous);
    if (stopping) return;
    const options = queue.shift();
    if (!options) return;
    const child = spawn(process.execPath, [invocation], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const worker: Worker = { child, prefix: `${++generation}:`, background: options.launchType === "background", ready: false, terminating: false, pendingInputBytes: 0, pendingInputMessages: 0, closed: Promise.resolve() };
    worker.closed = new Promise(resolve => {
      child.once("close", () => {
        emit({ type: "invocation-ended", pid: child.pid });
        resolve();
        if (active === worker && !worker.terminating) { active = undefined; advance().catch(report); }
      });
    });
    active = worker;
    child.once("spawn", () => emit({ type: "invocation-started", pid: child.pid }));
    child.stderr.pipe(process.stderr, { end: false });
    child.stdin.on("error", error => { if (active === worker) fail(worker, error); });
    child.on("error", report);
    child.on("exit", (code, signal) => {
      if (worker.terminating) return;
      killGroup(child);
      if (active === worker) {
        active = undefined;
        report(new Error(`Extension invocation exited unexpectedly (${signal || code})`));
        advance().catch(report);
      }
    });
    const listen = async (): Promise<void> => {
      try {
        for await (const line of protocolLines(child.stdout, 16 * 1024 * 1024)) {
          if (worker.terminating || active !== worker) continue;
          try { receive(worker, outputMessage(JSON.parse(line))); } catch (error) { report(error); }
        }
      } catch (error) {
        fail(worker, error);
      }
    };
    listen().catch(report);
    write(worker, options);
  } finally {
    launching = false;
    if (!stopping && queue.length && (!active || active.ready)) advance().catch(report);
  }
}

function receive(worker: Worker, message: WireMessage): void {
  if (message.type === "invocation-ready") {
    worker.ready = true;
    advance().catch(report);
  } else if (message.type === "relaunch") {
    if (!isRecord(message.options)) throw new Error("Invalid extension relaunch");
    const options = inputMessage({ ...message.options, type: "launch" });
    if (options.type !== "launch") return;
    if (queue.length >= MAX_QUEUED_LAUNCHES) throw new Error("Too many queued extension launches");
    worker.ready = true;
    queue.unshift(options);
    advance().catch(report);
  } else if (message.type === "done") {
    worker.ready = true;
    active = undefined;
    launching = true;
    terminate(worker).then(() => { emit(message); launching = false; return advance(); }).catch(error => { launching = false; report(error); });
  } else if (message.type === "render") {
    emit({ ...message, tree: tree(renderTree(message.tree), worker.prefix) });
  } else if (message.type === "request" || message.type === "cancel-request") {
    if (typeof message.id !== "string") throw new Error("Invalid extension request id");
    emit({ ...message, id: `${worker.prefix}${message.id}` });
  } else emit(message);
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  queue.length = 0;
  await terminate(active);
  process.exit(0);
}
process.once("SIGTERM", () => { stop().catch(report); });
process.once("SIGINT", () => { stop().catch(report); });

try {
  for await (const line of protocolLines(process.stdin)) {
    try {
      const message = inputMessage(JSON.parse(line));
      if (message.type === "launch") {
        if (message.scheduled) {
          for (let index = queue.length - 1; index >= 0; index--) if (queue[index]?.scheduled) queue.splice(index, 1);
          if (active?.background) active.ready = true;
        }
        if (queue.length >= MAX_QUEUED_LAUNCHES) throw new Error("Too many queued extension launches");
        queue.push(message);
        advance().catch(report);
      } else if (message.type === "stop") break;
      else if (active && !active.terminating) {
        if (message.type === "event") {
          if (!message.callback.startsWith(active.prefix)) continue;
          message.callback = message.callback.slice(active.prefix.length);
        } else if (message.type === "response") {
          if (!message.id.startsWith(active.prefix)) continue;
          message.id = message.id.slice(active.prefix.length);
        }
        write(active, message);
      }
    } catch (error) { report(error); }
  }
} catch (error) { report(error); }
await stop();
