import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { outputMessage, type InputMessage, type WireMessage } from "../../../runtime/protocol.ts";
import { nodes, submitCallback, recordedString } from "./protocol.ts";
import { FieldError } from "../src/workflows.ts";
import { moveBounds, resizeBounds } from "../src/window-bounds.ts";

const extension = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtime = path.resolve(extension, "../../runtime/host.ts");

test("window dimensions accept exact pixel integers and reject lossy or invalid input", () => {
  assert.deepEqual(moveBounds({ x: " -120 ", y: "+40" }), { position: { x: -120, y: 40 } });
  assert.deepEqual(resizeBounds({ width: "800", height: "600" }), { size: { width: 800, height: 600 } });
  for (const value of ["", "12.5", "1e3", "0x20", "NaN", "Infinity", "2147483648", "-2147483649"]) {
    assert.throws(() => moveBounds({ x: value, y: "0" }), error => error instanceof FieldError && error.field === "x");
  }
  for (const value of ["", "0", "-1", "1.5", "2147483648"]) {
    assert.throws(() => resizeBounds({ width: "800", height: value }), error => error instanceof FieldError && error.field === "height");
  }
});

async function fixture(t: TestContext, command: string, fullscreen = false) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "super-space-window-form-"));
  await fs.mkdir(path.join(home, "bin"));
  const target = { id: "42", stableId: "42", title: "Recorded window", class: "fixture", mapped: true, at: [120, 80], size: [800, 600], workspace: { id: 1, name: "work" }, fullscreen: fullscreen ? 2 : 0, pid: 1234, monitor: 0 };
  const launcher = { ...target, id: "99", stableId: "99", title: "Super Space", class: "super-space" };
  await fs.writeFile(path.join(home, "clients.json"), JSON.stringify([target, launcher]));
  await fs.writeFile(path.join(home, "bin/hyprctl"), `#!${process.execPath}
const fs=require('node:fs');
const path=require('node:path');
const args=process.argv.slice(2);
const clients=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'clients.json')));
if(args[0]==='-j')console.log(JSON.stringify(args[1]==='clients'?clients:clients.find(window=>window.class==='super-space')));
else if(args[0]==='eval'){fs.appendFileSync(path.join(process.env.HOME,'dispatches.jsonl'),JSON.stringify(args[1])+'\\n');console.log('ok')}
else process.exit(1);
`, { mode: 0o755 });
  const child = spawn(process.execPath, [runtime], { env: { ...process.env, HOME: home, PATH: `${home}/bin:${process.env.PATH}`, XDG_DATA_HOME: path.join(home, "data"), SUPER_SPACE_FRONTMOST: JSON.stringify(target) } });
  const messages: WireMessage[] = [];
  let stderr = "";
  readline.createInterface({ input: child.stdout }).on("line", line => messages.push(outputMessage(JSON.parse(line))));
  child.stderr.on("data", data => { stderr += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill(); await closed; }
    await fs.rm(home, { recursive: true, force: true });
  });
  const send = (value: InputMessage) => child.stdin.write(`${JSON.stringify(value)}\n`);
  async function wait(predicate: (message: WireMessage) => unknown): Promise<WireMessage> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const error = messages.find(message => message.type === "error");
      if (error) throw new Error(String(error.message));
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Window form timed out: ${JSON.stringify(messages)} ${stderr}`);
  }
  send({ type: "launch", extension, command });
  return { home, target, send, wait, messages };
}

for (const command of ["move-window", "resize-window"]) test(`${command} submits only the requested geometry to the captured window`, async t => {
  const host = await fixture(t, command);
  const moving = command === "move-window";
  const field = moving ? "x" : "width";
  const rendered = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.props.id === field && node.props.value === (moving ? "120" : "800")));
  assert.ok(nodes(rendered.tree).some(node => node.type === "Form.Description" && node.props.text === "Recorded window"));
  host.send({ type: "event", callback: submitCallback(rendered.tree), args: [moving ? { x: "-40", y: "60" } : { width: "640", height: "480" }] });
  await host.wait(message => message.type === "close");
  const dispatches = (await fs.readFile(path.join(host.home, "dispatches.jsonl"), "utf8")).trim().split("\n").map(recordedString);
  assert.equal(dispatches.length, 2);
  assert.ok(dispatches.every(command => command.includes('stableid:42') && !command.includes('stableid:99')));
  assert.match(dispatches[1], moving ? /resize\(\{window="stableid:42",x=800,y=600,relative=false\}\)/ : /resize\(\{window="stableid:42",x=640,y=480,relative=false\}\)/);
  assert.match(dispatches[1], moving ? /move\(\{window="stableid:42",x=-40,y=60,relative=false\}\)/ : /move\(\{window="stableid:42",x=120,y=80,relative=false\}\)/);
});

test("invalid window input displays a field error without dispatching", async t => {
  const host = await fixture(t, "resize-window");
  const rendered = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.props.id === "width" && node.props.value === "800"));
  host.send({ type: "event", callback: submitCallback(rendered.tree), args: [{ width: "640.5", height: "480" }] });
  await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.props.id === "width" && node.props.error));
  await assert.rejects(fs.access(path.join(host.home, "dispatches.jsonl")), { code: "ENOENT" });
  assert.equal(host.messages.some(message => message.type === "close"), false);
});

test("fullscreen forms wait for explicit numeric geometry and do not move on open", async t => {
  const host = await fixture(t, "move-window", true);
  const rendered = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.props.id === "x"));
  for (const id of ["x", "y"]) assert.equal(nodes(rendered.tree).find(node => node.props.id === id)?.props.value, "");
  await assert.rejects(fs.access(path.join(host.home, "dispatches.jsonl")), { code: "ENOENT" });
});
