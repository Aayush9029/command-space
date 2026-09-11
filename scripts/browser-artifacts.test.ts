import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import {verifyBrowserArtifacts} from "./browser-artifacts.ts";

type Browser = Parameters<typeof verifyBrowserArtifacts>[1];
const browsers: Browser[] = ["chromium", "firefox"];
const background = 'console.log("compiled background");\n';
const popup = 'console.log("compiled popup");\n';

function manifest(browser: Browser, backgroundScript = "dist/background.js") {
  return {
    manifest_version: 3,
    name: "Fixture browser bridge",
    version: "1.0.0",
    background: browser === "chromium" ? {service_worker: backgroundScript} : {scripts: [backgroundScript]},
    action: {default_popup: "popup.html"},
  };
}

async function fixture(t: TestContext, browser: Browser): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "super-space-browser-artifacts-"));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  await fs.mkdir(path.join(directory, "dist"));
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest(browser)));
  await fs.writeFile(path.join(directory, "popup.html"), '<!doctype html><html><body><script src="dist/popup.js"></script></body></html>');
  await fs.writeFile(path.join(directory, "dist/background.js"), background);
  await fs.writeFile(path.join(directory, "dist/popup.js"), popup);
  return directory;
}

for (const browser of browsers) {
  test(`${browser} browser artifacts include compiled background and popup programs`, async t => {
    const directory = await fixture(t, browser);
    await verifyBrowserArtifacts(directory, browser);
  });

  test(`${browser} browser artifacts reject a missing compiled background without rebuilding`, async t => {
    const directory = await fixture(t, browser);
    const compiled = path.join(directory, "dist/background.js");
    await fs.unlink(compiled);
    await fs.writeFile(path.join(directory, "background.ts"), background);
    await assert.rejects(verifyBrowserArtifacts(directory, browser), /background|ENOENT/i);
    await assert.rejects(fs.access(compiled), {code: "ENOENT"});
  });

  test(`${browser} browser artifacts reject a missing popup page`, async t => {
    const directory = await fixture(t, browser);
    await fs.unlink(path.join(directory, "popup.html"));
    await assert.rejects(verifyBrowserArtifacts(directory, browser), /popup|ENOENT/i);
  });

  test(`${browser} browser artifacts reject a missing compiled popup without rebuilding`, async t => {
    const directory = await fixture(t, browser);
    const compiled = path.join(directory, "dist/popup.js");
    await fs.unlink(compiled);
    await fs.writeFile(path.join(directory, "popup.ts"), popup);
    await assert.rejects(verifyBrowserArtifacts(directory, browser), /popup|ENOENT/i);
    await assert.rejects(fs.access(compiled), {code: "ENOENT"});
  });

  for (const program of ["background", "popup"]) {
    for (const [description, contents] of [["empty", ""], ["whitespace-only", " \n\t "]] as const) {
      test(`${browser} browser artifacts reject ${description} compiled ${program}`, async t => {
        const directory = await fixture(t, browser);
        await fs.writeFile(path.join(directory, `dist/${program}.js`), contents);
        await assert.rejects(verifyBrowserArtifacts(directory, browser));
      });
    }
  }

  for (const [description, contents] of [
    ["invalid syntax", "const = ;"],
    ["an unresolved import", 'import "./missing.js";'],
    ["a module export", "export const value = true;"],
  ] as const) {
    test(`${browser} browser artifacts reject compiled programs containing ${description}`, async t => {
      const directory = await fixture(t, browser);
      await fs.writeFile(path.join(directory, "dist/background.js"), contents);
      await assert.rejects(verifyBrowserArtifacts(directory, browser));
    });
  }

  test(`${browser} browser artifacts reject a stale top-level background reference even when its file exists`, async t => {
    const directory = await fixture(t, browser);
    await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest(browser, "background.js")));
    await fs.writeFile(path.join(directory, "background.js"), background);
    await assert.rejects(verifyBrowserArtifacts(directory, browser));
  });

  test(`${browser} browser artifacts reject a stale top-level popup reference even when its file exists`, async t => {
    const directory = await fixture(t, browser);
    await fs.writeFile(path.join(directory, "popup.html"), '<!doctype html><html><body><script src="popup.js"></script></body></html>');
    await fs.writeFile(path.join(directory, "popup.js"), popup);
    await assert.rejects(verifyBrowserArtifacts(directory, browser));
  });
}
