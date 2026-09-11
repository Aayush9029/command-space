import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

export async function buildPackageCompatibility(runtime: string): Promise<void> {
  await fs.access(path.join(runtime, "host.ts"));
  const source = await fs.readFile(new URL("../runtime/legacy-host.ts", import.meta.url), "utf8");
  const javascript = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(source);
  await fs.writeFile(path.join(runtime, "host.mjs"), javascript, { flag: "wx" });
}

if (import.meta.main) {
  const runtime = process.argv[2];
  assert.ok(runtime, "Supply the staged package runtime directory");
  await buildPackageCompatibility(path.resolve(runtime));
}
