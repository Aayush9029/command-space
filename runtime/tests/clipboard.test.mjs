import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {Clipboard} from "../clipboard.mjs";

const enabled = Boolean(process.env.SUPER_SPACE_CLIPBOARD_TEST && process.env.WAYLAND_DISPLAY);

test("Wayland clipboard preserves HTML alternatives, files, and confidential MIME hints", {skip:!enabled}, async t => {
  globalThis.__superSpace = {launcherPath:process.env.SUPER_SPACE_BINARY || "super-space",emit:()=>{}};
  const folder = await fs.mkdtemp(path.join(os.tmpdir(),"super-space-clipboard-"));
  t.after(async () => {await Clipboard.copy("Super Space clipboard validation complete"); await fs.rm(folder,{recursive:true,force:true});});
  await Clipboard.copy({text:"Rich text fixture",html:"<b>Rich text fixture</b>"});
  assert.deepEqual(await Clipboard.read(),{text:"Rich text fixture",html:"<b>Rich text fixture</b>"});
  const file = path.join(folder,"file with spaces #1.txt"); await fs.writeFile(file,"fixture");
  await Clipboard.copy({file}); assert.equal((await Clipboard.read()).file,file);
  await assert.rejects(Clipboard.copy({file:path.join(folder,"missing.txt")}),/does not exist/);
  const confidential = `Super Space confidential fixture ${Date.now()}`;
  await Clipboard.copy(confidential,{concealed:true});
  assert.equal(await Clipboard.readText(),confidential);
  const types = execFileSync("wl-paste",["--list-types"],{encoding:"utf8"});
  assert.ok(types.split("\n").includes("x-kde-passwordManagerHint"));
  const captured = execFileSync("/usr/share/omarchy/shell/plugins/clipboard/capture.sh",[],{encoding:"utf8",timeout:5000});
  assert.equal(captured,"");
  await new Promise(resolve => setTimeout(resolve,200));
  const history = await fs.readFile(path.join(process.env.HOME,".local/state/omarchy/clipboard-history.json"),"utf8");
  assert.ok(!history.includes(confidential));
  await assert.rejects(Clipboard.read({offset:6}),/between 0 and 5/);
});


test("clipboard history offsets preserve text and image entries", async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(),"super-space-history-"));
  const original = process.env.XDG_STATE_HOME;
  t.after(async () => {if (original === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME=original; await fs.rm(state,{recursive:true,force:true});});
  process.env.XDG_STATE_HOME=state;
  await fs.mkdir(path.join(state,"omarchy"));
  await fs.writeFile(path.join(state,"omarchy/clipboard-history.json"),JSON.stringify([{type:"text",text:"current"},{type:"text",text:"previous"},{type:"image",path:"/tmp/fixture.png"}]));
  assert.equal(await Clipboard.readText({offset:1}),"previous");
  assert.deepEqual(await Clipboard.read({offset:2}),{file:"/tmp/fixture.png"});
  assert.deepEqual(await Clipboard.read({offset:5}),{});
  await assert.rejects(Clipboard.read({offset:-1}),/between 0 and 5/);
});
