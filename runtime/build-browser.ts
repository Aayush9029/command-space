import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("./browser-extension/", import.meta.url));

export async function buildBrowser(): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["background.ts", "popup.ts"].map(name => path.join(directory, name)),
    outdir: path.join(directory, "dist"),
    target: "browser",
    format: "iife",
    minify: true,
  });
  if (!result.success) throw new AggregateError(result.logs, "Could not build the browser bridge");
}

if (import.meta.main) await buildBrowser();
