import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {getApplications,getDefaultApplication} from "../applications.ts";

test("application associations honor the target file and URL type", {skip:!process.env.SUPER_SPACE_DESKTOP_API_TEST}, async t => {
  globalThis.__superSpace = {launcherPath:process.env.SUPER_SPACE_BINARY || "super-space"};
  const apps = await getApplications(); assert.ok(apps.length > 0);
  const browser = await getDefaultApplication("https://example.org");
  const expected = execFileSync("xdg-mime",["query","default","x-scheme-handler/https"],{encoding:"utf8"}).trim();
  assert.equal(path.basename(browser.path),expected);
  const folder = await fs.mkdtemp(path.join(os.tmpdir(),"super-space-apps-"));
  t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  const file = path.join(folder,"fixture.txt"); await fs.writeFile(file,"plain text");
  const editor = await getDefaultApplication(file);
  const expectedEditor = execFileSync("xdg-mime",["query","default","text/plain"],{encoding:"utf8"}).trim();
  assert.equal(path.basename(editor.path),expectedEditor);
  const compatible = await getApplications(file);
  for (const application of compatible) assert.match(await fs.readFile(application.path,"utf8"),/MimeType=.*text\/plain/);
});
