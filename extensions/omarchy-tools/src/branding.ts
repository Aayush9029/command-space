import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { FieldError, hasErrorCode } from "./workflows.ts";

export type BrandingTarget = "about" | "screensaver";

export interface BrandingOptions {
  home?: string;
  omarchyPath?: string;
}

function brandingPath(target: BrandingTarget, home: string) {
  if (!["about", "screensaver"].includes(target)) throw new Error("Unknown branding target");
  return path.join(home, ".config/omarchy/branding", `${target}.txt`);
}

export async function readBranding(target: BrandingTarget, { home = os.homedir(), omarchyPath = process.env.OMARCHY_PATH || "/usr/share/omarchy" }: BrandingOptions = {}) {
  try { return await fs.readFile(brandingPath(target, home), "utf8"); }
  catch (error) { if (!hasErrorCode(error, "ENOENT")) throw error; }
  return fs.readFile(path.join(omarchyPath, target === "about" ? "icon.txt" : "logo.txt"), "utf8");
}

export async function writeBranding(target: BrandingTarget, content: unknown, { home = os.homedir() }: BrandingOptions = {}) {
  if (typeof content !== "string" || content.includes("\0") || Buffer.byteLength(content) > 1048576) throw new FieldError("text", "Use text smaller than 1 MB without null characters");
  const file = brandingPath(target, home);
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${target}-${randomUUID()}.tmp`);
  try { await fs.writeFile(temporary, content, { mode: 0o644 }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}

export async function resetBranding(target: BrandingTarget, options: BrandingOptions = {}) {
  const original = path.join(options.omarchyPath || process.env.OMARCHY_PATH || "/usr/share/omarchy", target === "about" ? "icon.txt" : "logo.txt");
  return writeBranding(target, await fs.readFile(original, "utf8"), options);
}
