import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "bun:test";
import { buildPackageCompatibility } from "./build-package-compatibility.ts";

const run = promisify(execFile);
const legacyUpdaterFiles = ["runtime/host.mjs", "runtime/bun.lock", "scripts/install-linux.sh", "scripts/start-daemon.sh"];

test("the generated legacy host runs TypeScript without changing launch arguments", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "super-space-host-compatibility-"));
  try {
    await fs.writeFile(path.join(directory, "host.ts"), 'const args: string[] = process.argv.slice(1); console.log(JSON.stringify(args));');
    await buildPackageCompatibility(directory);
    const shim = path.join(directory, "host.mjs");
    const { stdout } = await run(process.execPath, [shim, "--fixture", "argument with spaces"]);
    const arguments_: unknown = JSON.parse(stdout);
    assert.deepEqual(arguments_, [await fs.realpath(shim), "--fixture", "argument with spaces"]);
    assert.deepEqual((await fs.readdir(directory)).sort(), ["host.mjs", "host.ts"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("legacy updater preflight rejects a TypeScript-only package and accepts the generated entry", async () => {
  const bundle = await fs.mkdtemp(path.join(os.tmpdir(), "super-space-legacy-preflight-"));
  const preflight = async () => {
    for (const relative of legacyUpdaterFiles) await fs.access(path.join(bundle, relative));
  };
  try {
    for (const relative of ["runtime/host.ts", ...legacyUpdaterFiles.filter(file => file !== "runtime/host.mjs")]) {
      await fs.mkdir(path.dirname(path.join(bundle, relative)), { recursive: true });
      await fs.writeFile(path.join(bundle, relative), "");
    }
    await assert.rejects(preflight(), /host\.mjs/);
    await buildPackageCompatibility(path.join(bundle, "runtime"));
    await preflight();
  } finally {
    await fs.rm(bundle, { recursive: true, force: true });
  }
});

test("a compatibility entry is not generated when the TypeScript host is missing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "super-space-missing-host-"));
  try {
    await assert.rejects(buildPackageCompatibility(directory), /host\.ts/);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
