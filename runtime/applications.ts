import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {isRecord, runDesktopCommand as run} from "./adapter-utils.ts";
import {getRuntimeContext} from "./types.ts";

export interface Application {
  name: string;
  localizedName?: string;
  bundleId: string;
  path: string;
  pid?: number;
}

async function mimeType(target: string | URL): Promise<string> {
  if (target instanceof URL) target = target.href;
  if (typeof target !== "string" || !target) throw new Error("Supply a file path or URL");
  if (target.startsWith("file:")) target = fileURLToPath(target);
  else if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return `x-scheme-handler/${new URL(target).protocol.slice(0, -1)}`;
  return (await run("xdg-mime", ["query", "filetype", path.resolve(target)])).trim();
}

export async function getApplications(target?: string | URL): Promise<Application[]> {
  const entries: unknown = JSON.parse(await run(getRuntimeContext().launcherPath, ["applications"]));
  if (!Array.isArray(entries)) throw new Error("The launcher returned an invalid application catalog");
  const applications = entries.map((entry: unknown): Application => {
    if (!isRecord(entry) || typeof entry.title !== "string" || typeof entry.id !== "string" || !isRecord(entry.action) || typeof entry.action.Desktop !== "string") {
      throw new Error("The launcher returned an invalid application catalog entry");
    }
    return {name: entry.title, localizedName: entry.title, bundleId: entry.id.replace(/^app:/, "").replace(/\.desktop$/, ""), path: entry.action.Desktop};
  });
  if (target === undefined) return applications;
  const mime = await mimeType(target);
  const matches = new Set<Application>();
  let index = 0;
  await Promise.all(Array.from({length: Math.min(16, applications.length)}, async () => {
    while (index < applications.length) {
      const application = applications[index++];
      if (!application) continue;
      const source = await fs.readFile(application.path, "utf8").catch(() => "");
      const types = source.split(/\r?\n/).find(line => line.startsWith("MimeType="))?.slice(9).split(";") || [];
      if (types.includes(mime)) matches.add(application);
    }
  }));
  return applications.filter(application => matches.has(application));
}

export async function getDefaultApplication(target: string | URL): Promise<Application> {
  const mime = await mimeType(target);
  const desktop = (await run("xdg-mime", ["query", "default", mime])).trim();
  if (!desktop) throw new Error(`No application is associated with ${mime}`);
  const applications = await getApplications();
  const installed = applications.find(application => path.basename(application.path) === desktop || `${application.bundleId}.desktop` === desktop);
  if (installed) return installed;
  if (path.basename(desktop) !== desktop) throw new Error("The default application must be a desktop file name");
  const directories = [process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share"), ...(process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":")];
  for (const directory of directories) {
    const file = path.join(directory, "applications", desktop);
    const source = await fs.readFile(file, "utf8").catch(() => null);
    if (source) {
      const name = source.match(/^Name=(.+)$/m)?.[1] || desktop.replace(/\.desktop$/, "");
      return {name, localizedName: name, path: file, bundleId: desktop.replace(/\.desktop$/, "")};
    }
  }
  throw new Error(`The default application ${desktop} is not installed`);
}

export async function getFrontmostApplication(): Promise<Application> {
  const previous: unknown = JSON.parse(process.env.SUPER_SPACE_FRONTMOST || "null");
  const active: unknown = previous || JSON.parse(await run("hyprctl", ["-j", "activewindow"]));
  if (!isRecord(active) || typeof active.class !== "string") throw new Error("There is no active application window");
  const applicationClass = active.class;
  const applications = await getApplications();
  const application = applications.find(value => value.bundleId.toLowerCase() === applicationClass.toLowerCase());
  return {name: applicationClass, bundleId: applicationClass, path: "", ...application, ...(typeof active.pid === "number" ? {pid: active.pid} : {})};
}
