import readline from "node:readline";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";

const invocation = fileURLToPath(new URL("./invocation.mjs",import.meta.url));
const emit = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const report = error => emit({type:"error",message:error.stack || String(error)});
const input = readline.createInterface({input:process.stdin});
let active;
let generation = 0;
let launching = false;
let stopping = false;
const queue = [];

function callbacks(value, prefix) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(item => callbacks(item,prefix));
  return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,key === "$callback" ? `${prefix}${item}` : callbacks(item,prefix)]));
}

function tree(nodes, prefix) {
  return nodes.map(node => ({...node,id:`${prefix}${node.id}`,props:callbacks(node.props,prefix),children:tree(node.children || [],prefix)}));
}

function terminate(worker) {
  if (!worker) return Promise.resolve();
  worker.terminating = true;
  try { process.kill(-worker.child.pid,"SIGKILL"); } catch(error) { if (error.code !== "ESRCH") report(error); }
  return worker.closed;
}

async function advance() {
  if (launching || stopping || !queue.length || (active && !active.ready)) return;
  launching = true;
  try {
    const previous = active;
    active = undefined;
    await terminate(previous);
    if (stopping) return;
    const options = queue.shift();
    const child = spawn(process.execPath,[invocation],{detached:true,stdio:["pipe","pipe","pipe"]});
    const worker = {child,prefix:`${++generation}:`,background:options.launchType === "background",ready:false,terminating:false,closed:null};
    worker.closed = new Promise(resolve => {
      child.once("close",() => { emit({type:"invocation-ended",pid:child.pid}); resolve(); });
    });
    active = worker;
    emit({type:"invocation-started",pid:child.pid});
    child.stderr.pipe(process.stderr,{end:false});
    child.stdin.on("error",error => { if (!worker.terminating && active === worker) report(error); });
    child.on("error",report);
    child.on("exit",(code,signal) => {
      if (worker.terminating) return;
      try { process.kill(-child.pid,"SIGKILL"); } catch {}
      if (active === worker) {
        active = undefined;
        report(new Error(`Extension invocation exited unexpectedly (${signal || code})`));
        advance().catch(report);
      }
    });
    readline.createInterface({input:child.stdout}).on("line",line => {
      if (worker.terminating || active !== worker) return;
      try { receive(worker,JSON.parse(line)); } catch(error) { report(error); }
    });
    child.stdin.write(`${JSON.stringify(options)}\n`);
  } finally {
    launching = false;
  }
}

function receive(worker,message) {
  if (message.type === "invocation-ready") {
    worker.ready = true;
    advance().catch(report);
  } else if (message.type === "relaunch") {
    worker.ready = true;
    queue.unshift({...message.options,type:"launch"});
    advance().catch(report);
  } else if (message.type === "done") {
    worker.ready = true;
    active = undefined;
    launching = true;
    terminate(worker).then(() => { emit(message); launching = false; return advance(); }).catch(error => { launching = false; report(error); });
  } else if (message.type === "render") {
    emit({...message,tree:tree(message.tree,worker.prefix)});
  } else if (message.type === "request" || message.type === "cancel-request") {
    emit({...message,id:`${worker.prefix}${message.id}`});
  } else emit(message);
}

async function stop() {
  if (stopping) return;
  stopping = true;
  queue.length = 0;
  input.close();
  await terminate(active);
  process.exit(0);
}
process.once("SIGTERM",() => { stop().catch(report); });
process.once("SIGINT",() => { stop().catch(report); });

for await (const line of input) {
  try {
    if (line.length > 1024 * 1024) throw new Error("Extension input exceeds one megabyte");
    const message = JSON.parse(line);
    if (message.type === "launch") {
      if (message.scheduled) {
        for (let index=queue.length-1;index>=0;index--) if (queue[index].scheduled) queue.splice(index,1);
        if (active?.background) active.ready = true;
      }
      queue.push(message);
      advance().catch(report);
    } else if (message.type === "stop") break;
    else if (active && !active.terminating) {
      const key = message.type === "event" ? "callback" : message.type === "response" ? "id" : undefined;
      if (key) {
        if (!String(message[key]).startsWith(active.prefix)) continue;
        message[key] = String(message[key]).slice(active.prefix.length);
      }
      active.child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  } catch(error) { report(error); }
}
await stop();
