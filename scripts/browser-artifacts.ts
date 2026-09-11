import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

function record(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Expected a browser manifest object");
}

export async function verifyBrowserArtifacts(directory: string, browser: "chromium" | "firefox"): Promise<void> {
  const manifest: unknown = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
  record(manifest);
  record(manifest.background);
  if (browser === "chromium") {
    assert.equal(manifest.background.service_worker, "dist/background.js", "Chromium must load dist/background.js");
  } else {
    assert.deepEqual(manifest.background.scripts, ["dist/background.js"], "Firefox must load dist/background.js");
    assert.equal(manifest.background.service_worker, undefined, "Firefox must use background scripts");
  }
  record(manifest.action);
  assert.equal(manifest.action.default_popup, "popup.html", "The browser manifest must reference popup.html");
  const popup = await fs.readFile(path.join(directory, "popup.html"), "utf8");
  const scripts = [...popup.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map(match => match[1]);
  assert.deepEqual(scripts, ["dist/popup.js"], "The popup must load dist/popup.js");
  const transpiler = new Bun.Transpiler({ loader: "js", target: "browser" });
  for (const target of ["dist/background.js", "dist/popup.js"]) {
    const script = await fs.readFile(path.join(directory, target), "utf8");
    assert.ok(script.trim().length > 0, `${browser} ${target} must not be empty`);
    const scan = transpiler.scan(script);
    assert.deepEqual(scan.imports, [], `${browser} ${target} must be bundled`);
    assert.deepEqual(scan.exports, [], `${browser} ${target} must run as a classic script`);
    transpiler.transformSync(script);
  }
}
