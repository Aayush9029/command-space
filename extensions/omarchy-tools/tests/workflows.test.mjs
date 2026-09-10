import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { webAppArguments, tuiArguments, reminderArguments, selectedPaths, transcodeArguments, brandingArguments, installWallpapers, installTheme, themeName, addShellPlugin, retroCores, retroGameArguments, run } from "../src/workflows.mjs";

async function temporary(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "command-space-workflow-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

test("launcher arguments reject desktop injection and preserve shell text as an argument", () => {
  assert.deepEqual(webAppArguments({ name: "My App", url: "example.com/a?q=%20", icon: "" }), ["My App", "https://example.com/a?q=%20", ""]);
  assert.deepEqual(tuiArguments({ name: "Terminal", command: "bash -c 'echo $HOME; read'", style: "tile" }), ["Terminal", "bash -c 'echo $HOME; read'", "tile", "utilities-terminal"]);
  for (const name of ["../escape", "bad\nExec=sh", "bad\tName"]) assert.throws(() => tuiArguments({ name, command: "true" }));
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "https://example.com --disable-sandbox"]) assert.throws(() => webAppArguments({ name: "App", url }));
  assert.throws(() => tuiArguments({ name: "App", command: "true\nExec=bad" }));
  assert.throws(() => tuiArguments({ name: "App", command: "true", style: "invalid" }));
});

test("reminders accept bounded whole minutes and a literal message", () => {
  assert.deepEqual(reminderArguments({ minutes: "005", message: "Check $(oven)" }), ["5", "Check $(oven)"]);
  for (const minutes of ["0", "-5", "1.5", "abc", "525601", "9e10"]) assert.throws(() => reminderArguments({ minutes }));
});

test("media arguments use detected MIME type, disallow overwrites and keep paths literal", async t => {
  const home = await temporary(t);
  const file = path.join(home, "$(literal).png");
  await fs.writeFile(file, "fixture");
  const image = async () => "image/png";
  const output = await transcodeArguments({ files: [file], format: "jpg", resolution: "low" }, image);
  assert.deepEqual(output.args, ["--", file, "jpg", "low"]);
  assert.equal(output.output, path.join(home, "$(literal)-low.jpg"));
  await assert.rejects(transcodeArguments({ files: [file], format: "mp4", resolution: "720p" }, image), /Choose jpg or png/);
  await assert.rejects(transcodeArguments({ files: [file], format: "jpg", resolution: "4k" }, image), /image resolution/);
  await fs.writeFile(output.output, "preserved");
  await assert.rejects(transcodeArguments({ files: [file], format: "jpg", resolution: "low" }, image), /already exists/);
  assert.equal(await fs.readFile(output.output, "utf8"), "preserved");
  await assert.rejects(selectedPaths([home]), /regular file/);
  await assert.rejects(selectedPaths([file], { directory: true }), /folder/);
  assert.deepEqual(await selectedPaths([file, file]), [file]);
  assert.deepEqual(await brandingArguments({ files: [file] }, "about", home), [file, path.join(home, ".config/omarchy/branding/about.txt"), "--width", "54", "--height", "26"]);
});

test("wallpapers preserve existing images and only apply when requested", async t => {
  const home = await temporary(t);
  await fs.mkdir(path.join(home, ".local/state/omarchy/current"), { recursive: true });
  await fs.writeFile(path.join(home, ".local/state/omarchy/current/theme.name"), "tokyo-night\n");
  const image = path.join(home, "picture.png");
  await fs.writeFile(image, "original image");
  const calls = [];
  const execute = async (command, args) => { calls.push([command, args]); return "image/png"; };
  const [first] = await installWallpapers({ files: [image], apply: false }, { home, execute });
  const [second] = await installWallpapers({ files: [image], apply: true }, { home, execute });
  assert.equal(first, path.join(home, ".config/omarchy/backgrounds/tokyo-night/picture.png"));
  assert.equal(second, path.join(home, ".config/omarchy/backgrounds/tokyo-night/picture-1.png"));
  assert.equal(await fs.readFile(first, "utf8"), "original image");
  assert.deepEqual(calls.filter(([command]) => command === "omarchy-theme-bg-set"), [["omarchy-theme-bg-set", [second]]]);
  await fs.writeFile(path.join(home, ".local/state/omarchy/current/theme.name"), "../../escape");
  await assert.rejects(installWallpapers({ files: [image] }, { home, execute }), /theme is not valid/);
});

test("runner passes literal argv and reports failures", async () => {
  const literal = "hello $(touch never); 'quote'\"";
  assert.equal(await run(process.execPath, ["-e", "process.stdout.write(process.argv[1])", literal]), literal);
  await assert.rejects(run(process.execPath, ["-e", "console.error('fixture failure'); process.exit(9)"]), /fixture failure/);
  await assert.rejects(run("command-space-missing-command-fixture", []), /not installed/);
});

test("theme installation protects installed themes and passes complete repository arguments", async t => {
  const home = await temporary(t);
  const calls = [];
  const execute = async (...args) => { calls.push(args); return ""; };
  assert.equal(themeName("git@example.com:owner/omarchy-blue-theme.git"), "blue");
  assert.throws(() => themeName("https://example.com/.."), /valid theme name/);
  await installTheme({ repository: "https://example.com/omarchy-blue-theme.git" }, { home, execute });
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [["omarchy-git-url-check", ["https://example.com/omarchy-blue-theme.git"]], ["omarchy-theme-install", ["https://example.com/omarchy-blue-theme.git"]]]);
  assert.equal(calls[1][2].env.GIT_TERMINAL_PROMPT, "0");
  await fs.mkdir(path.join(home, ".config/omarchy/themes/blue"), { recursive: true });
  calls.length = 0;
  await assert.rejects(installTheme({ repository: "https://example.com/omarchy-blue-theme.git" }, { home, execute }), /already installed/);
  assert.equal(calls.some(([command]) => command === "omarchy-theme-install"), false);
});

test("shell plugins use explicit noninteractive mode and preserve bar placement semantics", async () => {
  const calls = [];
  const execute = async (command, args) => {
    calls.push([command, args]);
    if (command === "omarchy-plugin-add") return "Added example.weather into /home/test/.config/omarchy/plugins/example.weather";
    if (command === "omarchy-plugin-catalog") return JSON.stringify([{ id: "example.weather", kinds: ["bar-widget"] }]);
    return "";
  };
  await addShellPlugin({ repository: "https://example.com/plugin.git", enable: true, section: "right" }, { execute });
  assert.deepEqual(calls, [
    ["omarchy-git-url-check", ["https://example.com/plugin.git"]],
    ["omarchy-plugin-add", ["https://example.com/plugin.git", "--yes"]],
    ["omarchy-plugin-catalog", []],
    ["omarchy-plugin-enable", ["example.weather", "--section", "right"]],
  ]);
  calls.length = 0;
  await addShellPlugin({ repository: "https://example.com/plugin.git", enable: false }, { execute });
  assert.equal(calls.some(([command]) => command === "omarchy-plugin-enable"), false);
});

test("retro launchers use discovered cores and reject paths unsafe for the original desktop writer", async t => {
  const home = await temporary(t);
  const file = path.join(home, "Game (USA).sfc");
  await fs.writeFile(file, "fixture");
  const output = "Nintendo SNES / SFC (snes9x)\nInvalid core (bad/../id)\n";
  assert.deepEqual(retroCores(output), [{ title: "Nintendo SNES / SFC", id: "snes9x" }]);
  assert.deepEqual(await retroGameArguments({ core: "snes9x", files: [file] }, async () => output), ["snes9x", file]);
  await assert.rejects(retroGameArguments({ core: "uninstalled", files: [file] }, async () => output), /installed RetroArch core/);
  const unsafe = path.join(home, 'Game"bad.sfc');
  await fs.writeFile(unsafe, "fixture");
  await assert.rejects(retroGameArguments({ core: "snes9x", files: [unsafe] }, async () => output), /Rename this file/);
});

test("canceling terminates a running operation before its side effect", async t => {
  const home = await temporary(t);
  const output = path.join(home, "canceled");
  const controller = new AbortController();
  const execution = run(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'bad'), 1000)", output], { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(execution, /abort/i);
  await new Promise(resolve => setTimeout(resolve, 1100));
  await assert.rejects(fs.access(output), { code: "ENOENT" });
});

test("closing the extension worker terminates its operation process group", { skip: process.platform === "win32" }, async t => {
  const home = await temporary(t);
  const marker = path.join(home, "started"), output = path.join(home, "orphan");
  const module = fileURLToPath(new URL("../src/workflows.mjs", import.meta.url));
  const source = `import {run} from ${JSON.stringify(module)}; await run(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], "ready"); setTimeout(()=>require("node:fs").writeFileSync(process.argv[2], "bad"), 1200)', ${JSON.stringify(marker)}, ${JSON.stringify(output)}]);`;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: "ignore" });
  t.after(() => parent.kill());
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fs.access(marker); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await fs.access(marker);
  parent.kill("SIGKILL");
  await new Promise(resolve => setTimeout(resolve, 1400));
  await assert.rejects(fs.access(output), { code: "ENOENT" });
});
