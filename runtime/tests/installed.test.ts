import test, { type TestContext } from "node:test";
import { renderTree, isRecord, type RenderNode, type WireMessage } from "../protocol.ts";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const runtime = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = process.env.SUPER_SPACE_TEST_EXTENSIONS;
const enabled = Boolean(root && process.env.WAYLAND_DISPLAY);
function nodes(tree: unknown): RenderNode[] { return renderTree(tree).flatMap(node => [node, ...nodes(node.children)]); }
function requireNode(tree: unknown, predicate: (node: RenderNode) => boolean): RenderNode {
  const node = nodes(tree).find(predicate);
  assert.ok(node, "Expected native extension node");
  return node;
}
function callback(value: unknown): string {
  assert.ok(isRecord(value) && typeof value.$callback === "string", "Expected serialized callback");
  return value.$callback;
}

async function worker(t: TestContext, extension: string, command: string, arguments_?: Record<string, string>) {
  assert.ok(root);
  const child = spawn(process.execPath, [path.join(runtime, "host.ts")]);
  const messages: WireMessage[] = [];
  let stderr = "";
  readline.createInterface({ input: child.stdout }).on("line", line => messages.push(JSON.parse(line)));
  child.stderr.on("data", data => { stderr += data; });
  t.after(() => { child.kill(); });
  const send = (message: WireMessage) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const wait = async (predicate: (message: WireMessage) => boolean) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const failure = messages.find(message => message.type === "error");
      if (failure) throw new Error(String(failure.message));
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out: ${JSON.stringify(messages)} ${stderr}`);
  };
  send({ type: "launch", extension: path.join(root, extension), command, arguments: arguments_ });
  return { send, wait, messages };
}

function clipboard(text: string) { execFileSync("wl-copy", [], { input: text, stdio: ["pipe", "ignore", "ignore"], timeout: 5000 }); }
function readClipboard() { return execFileSync("wl-paste", ["--no-newline", "--type", "text"], { encoding: "utf8" }); }

test("unmodified Raycast Base64 renders with @raycast/utils and copies output", { skip: !enabled }, async t => {
  clipboard("Super Space compatibility");
  const host = await worker(t, "base64", "index");
  const first = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "List.Item" && node.props.title === "Encode"));
  const item = requireNode(first.tree, node => node.type === "List.Item" && node.props.title === "Encode");
  assert.equal(item.props.subtitle, Buffer.from("Super Space compatibility").toString("base64"));
  const action = requireNode([item], node => node.type === "Action");
  host.send({ type: "event", callback: callback(action.props.onAction), args: [] });
  const deadline = Date.now() + 3000;
  while (readClipboard() !== item.props.subtitle && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(readClipboard(), item.props.subtitle);
});

test("unmodified UUID extension receives launch arguments and persists history", { skip: !enabled }, async t => {
  const host = await worker(t, "uuid-generator", "generate", { numberOfUUIDsToGenerate: "3" });
  await host.wait(message => message.type === "done");
  const values = readClipboard().trim().split(/\s+/);
  assert.equal(values.length, 3);
  assert.ok(values.every(value => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)));
  const history = await worker(t, "uuid-generator", "viewHistory");
  await history.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "List.Item"));
});

test("unmodified Lorem Ipsum generates the requested word count", { skip: !enabled }, async t => {
  const host = await worker(t, "lorem-ipsum", "words", { numberOfWords: "7" });
  await host.wait(message => message.type === "done");
  assert.equal(readClipboard().trim().split(/\s+/).length, 7);
});

test("unmodified JSON Format uses a React form, nested detail navigation, and clipboard output", {skip:!enabled}, async t => {
  const host = await worker(t,"json-format","index");
  const first = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "Form.TextArea"));
  const input = requireNode(first.tree, node => node.type === "Form.TextArea");
  const value = JSON.stringify({project:"Super Space",linux:true,plugins:["TypeScript","React"]});
  host.send({type:"event",callback:callback(input.props.onChange),field:input.props.id,inputRevision:1,args:[value]});
  const updated = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.props.value === value));
  const action = requireNode(updated.tree, node => node.props.title === "View Result");
  host.send({type:"event",callback:callback(action.props.onAction),args:[{input:value}]});
  const detail = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.props.navigationTitle === "Formatted JSON"));
  const copy = requireNode(detail.tree, node => node.props.title === "Copy to Clipboard");
  host.send({type:"event",callback:callback(copy.props.onAction)});
  const deadline = Date.now()+3000;
  while (!readClipboard().includes('"linux": true') && Date.now()<deadline) await new Promise(resolve => setTimeout(resolve,20));
  assert.deepEqual(JSON.parse(readClipboard()),JSON.parse(value));
});

test("unmodified Days Until Christmas renders a live menu-bar extension", {skip:!enabled}, async t => {
  const host = await worker(t, "days-until-christmas", "menu-bar");
  const render = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "MenuBarExtra"));
  const menu = requireNode(render.tree, node => node.type === "MenuBarExtra");
  assert.match(String(menu.props.title || menu.props.tooltip), /Christmas|days/i);
  assert.ok(typeof menu.props.icon === "string" && menu.props.icon.length > 0);
});
