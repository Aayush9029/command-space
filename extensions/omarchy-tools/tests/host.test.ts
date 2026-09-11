import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import manifest from "../package.json";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { outputMessage, type InputMessage, type WireMessage } from "../../../runtime/protocol.ts";
import { nodes, submitCallback, requestID, recordedCall } from "./protocol.ts";

const extension = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtime = path.resolve(extension, "../../runtime/host.ts");

async function fixture(t: TestContext, command: string) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "super-space-workflow-host-"));
  await fs.mkdir(path.join(home, "bin"));
  for (const command of ["omarchy-webapp-install", "omarchy-tui-install", "omarchy-reminder", "omarchy-menu-share", "omarchy-transcode", "omarchy-transcode-ascii", "omarchy-theme-bg-set", "omarchy-games-retro-cores", "omarchy-games-retro-install", "omarchy-theme-install", "omarchy-git-url-check", "omarchy-plugin-add", "omarchy-plugin-catalog", "omarchy-plugin-enable", "omarchy-dns", "systemd-run"]) {
    const source = `#!/usr/bin/env python3
import json, os, sys
command = os.path.basename(sys.argv[0])
with open(os.path.join(os.environ["HOME"], "calls.jsonl"), "a") as output:
    output.write(json.dumps([command, sys.argv[1:]]) + "\\n")
if sys.argv[1:2] == ["show"]: print(json.dumps({"reminders": []}))
if command == "omarchy-games-retro-cores": print("Nintendo SNES / SFC (snes9x)")
if command == "omarchy-plugin-add": print("Added fixture.widget into " + os.environ["HOME"] + "/.config/omarchy/plugins/fixture.widget")
if command == "omarchy-plugin-catalog": print(json.dumps([{"id": "fixture.widget", "kinds": ["bar-widget"]}]))
`;
    await fs.writeFile(path.join(home, "bin", command), source, { mode: 0o755 });
  }
  const child = spawn(process.execPath, [runtime], { env: { ...process.env, HOME: home, PATH: `${home}/bin:${process.env.PATH}`, XDG_DATA_HOME: path.join(home, "data") } });
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
    throw new Error(`Timed out: ${JSON.stringify(messages)} ${stderr}`);
  }
  send({ type: "launch", extension, command });
  return { home, send, wait, messages, async calls() { return (await fs.readFile(path.join(home, "calls.jsonl"), "utf8")).trim().split("\n").map(recordedCall); } };
}

test("all bundled workflow forms render without opening old pickers", async t => {
  for (const command of manifest.commands.filter(command => command.mode === "view")) {
    await t.test(command.name, async t => {
      const host = await fixture(t, command.name);
      const rendered = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => ["Form", "List"].includes(node.type)));
      assert.ok(nodes(rendered.tree).some(node => node.type === "Action.SubmitForm" || node.type === "Action"));
      if (!["reminders", "install-retro-game"].includes(command.name)) await assert.rejects(fs.access(path.join(host.home, "calls.jsonl")), { code: "ENOENT" });
    });
  }
});

test("web app form validates before executing and passes all noninteractive arguments", async t => {
  const host = await fixture(t, "install-web-app");
  const first = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "Action.SubmitForm"));
  host.send({ type: "event", callback: submitCallback(first.tree), args: [{ name: "../bad", url: "example.com" }] });
  const invalid = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.props.id === "name" && node.props.error));
  await assert.rejects(fs.access(path.join(host.home, "calls.jsonl")), { code: "ENOENT" });
  host.send({ type: "event", callback: submitCallback(invalid.tree), args: [{ name: "Fixture App", url: "example.com", icon: "internet-web-browser" }] });
  await host.wait(message => message.type === "close");
  assert.deepEqual(await host.calls(), [["omarchy-webapp-install", ["Fixture App", "https://example.com/", "internet-web-browser"]]]);
});

test("TUI form passes command text literally and never invokes a terminal prompt", async t => {
  const host = await fixture(t, "install-tui");
  const first = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "Action.SubmitForm"));
  host.send({ type: "event", callback: submitCallback(first.tree), args: [{ name: "Fixture TUI", command: "bash -c 'echo $HOME; read'", style: "tile", icon: "utilities-terminal" }] });
  await host.wait(message => message.type === "close");
  assert.deepEqual(await host.calls(), [["omarchy-tui-install", ["Fixture TUI", "bash -c 'echo $HOME; read'", "tile", "utilities-terminal"]]]);
});

test("declining replacement and reminder clearing has no side effect", async t => {
  const app = await fixture(t, "install-web-app");
  await fs.mkdir(path.join(app.home, ".local/share/applications"), { recursive: true });
  await fs.writeFile(path.join(app.home, ".local/share/applications/Existing.desktop"), "preserved");
  const first = await app.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "Action.SubmitForm"));
  app.send({ type: "event", callback: submitCallback(first.tree), args: [{ name: "Existing", url: "example.com" }] });
  const request = await app.wait(message => message.type === "request" && message.kind === "confirm");
  app.send({ type: "response", id: requestID(request), value: false });
  await app.wait(message => message.type === "render" && message !== first && nodes(message.tree).some(node => node.type === "Action.SubmitForm"));
  await assert.rejects(fs.access(path.join(app.home, "calls.jsonl")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(app.home, ".local/share/applications/Existing.desktop"), "utf8"), "preserved");
  const clear = await fixture(t, "clear-reminders");
  const confirmation = await clear.wait(message => message.type === "request" && message.kind === "confirm");
  clear.send({ type: "response", id: requestID(confirmation), value: false });
  await clear.wait(message => message.type === "done");
  await assert.rejects(fs.access(path.join(clear.home, "calls.jsonl")), { code: "ENOENT" });
});

test("workflow submissions call each original operation with complete arguments", async t => {
  const cases: { command: string; values: (file: string, home: string) => Record<string, unknown>; expected: (file: string, home: string) => [string, string[]] }[] = [
    { command: "reminder", values: () => ({ minutes: "15", message: "Check the oven" }), expected: () => ["omarchy-reminder", ["15", "Check the oven"]] },
    { command: "share-files", values: file => ({ files: [file] }), expected: file => ["omarchy-menu-share", ["file", file]] },
    { command: "share-folder", values: (_file, home) => ({ files: [home] }), expected: (_file, home) => ["omarchy-menu-share", ["folder", home]] },
    { command: "transcode", values: file => ({ files: [file], format: "jpg", resolution: "low" }), expected: file => ["omarchy-transcode", ["--", file, "jpg", "low"]] },
    { command: "about-image", values: file => ({ files: [file] }), expected: (file, home) => ["omarchy-transcode-ascii", [file, path.join(home, ".config/omarchy/branding/about.txt"), "--width", "54", "--height", "26"]] },
    { command: "screensaver-image", values: file => ({ files: [file] }), expected: (file, home) => ["omarchy-transcode-ascii", [file, path.join(home, ".config/omarchy/branding/screensaver.txt"), "--width", "80", "--height", "26"]] },
    { command: "install-wallpaper", values: file => ({ files: [file], apply: true }), expected: (_file, home) => ["omarchy-theme-bg-set", [path.join(home, ".config/omarchy/backgrounds/fixture/fixture.png")]] },
    { command: "install-theme", values: () => ({ repository: "https://example.com/omarchy-fixture-theme.git" }), expected: () => ["omarchy-theme-install", ["https://example.com/omarchy-fixture-theme.git"]] },
    { command: "install-retro-game", values: file => ({ files: [file], core: "snes9x" }), expected: file => ["omarchy-games-retro-install", ["snes9x", file]] },
  ];
  for (const example of cases) await t.test(example.command, async t => {
    const host = await fixture(t, example.command);
    const file = path.join(host.home, "fixture.png");
    await fs.writeFile(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvWYAAAAASUVORK5CYII=", "base64"));
    await fs.mkdir(path.join(host.home, ".local/state/omarchy/current"), { recursive: true });
    await fs.writeFile(path.join(host.home, ".local/state/omarchy/current/theme.name"), "fixture");
    const first = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "Action.SubmitForm"));
    host.send({ type: "event", callback: submitCallback(first.tree), args: [example.values(file, host.home)] });
    await host.wait(message => message.type === "close");
    const calls = await host.calls();
    const expected = example.expected(file, host.home);
    assert.ok(calls.some(call => JSON.stringify(call) === JSON.stringify(expected)), `${example.command}: expected ${JSON.stringify(expected)} in ${JSON.stringify(calls)}`);
  });
});

test("adding a shell plugin waits for native confirmation before cloning and enabling", async t => {
  const host = await fixture(t, "add-shell-plugin");
  const first = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "Action.SubmitForm"));
  host.send({ type: "event", callback: submitCallback(first.tree),
    args: [{ repository: "https://example.com/widget.git", enable: true, section: "right" }] });
  const confirmation = await host.wait(message => message.type === "request" && message.kind === "confirm");
  await assert.rejects(fs.access(path.join(host.home, "calls.jsonl")), { code: "ENOENT" });
  host.send({ type: "response", id: requestID(confirmation), value: true });
  await host.wait(message => message.type === "close");
  assert.deepEqual(await host.calls(), [
    ["omarchy-git-url-check", ["https://example.com/widget.git"]],
    ["omarchy-plugin-add", ["https://example.com/widget.git", "--yes"]],
    ["omarchy-plugin-catalog", []],
    ["omarchy-plugin-enable", ["fixture.widget", "--section", "right"]],
  ]);
});

test("branding text forms save multiline Unicode", async t => {
  for (const target of ["about", "screensaver"]) await t.test(target, async t => {
    const host = await fixture(t, `${target}-text`);
    const rendered = await host.wait(message => message.type === "render" && nodes(message.tree).some(node => node.type === "Action.SubmitForm"));
    const text = "┌──────┐\n│ Test │\n└──────┘\n";
    host.send({ type: "event", callback: submitCallback(rendered.tree), args: [{ text }] });
    await host.wait(message => message.type === "close");
    assert.equal(await fs.readFile(path.join(host.home, `.config/omarchy/branding/${target}.txt`), "utf8"), text);
  });
});
