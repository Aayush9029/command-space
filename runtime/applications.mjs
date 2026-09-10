import fs from "node:fs/promises";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";

const execute = promisify(execFile);
const run = async (program,args) => (await execute(program,args,{encoding:"utf8",timeout:5000,maxBuffer:4*1024*1024})).stdout;
const bridge = () => globalThis.__commandSpace;

async function mimeType(target) {
  if (target instanceof URL) target = target.href;
  if (typeof target !== "string" || !target) throw new Error("Supply a file path or URL");
  if (target.startsWith("file:")) target = fileURLToPath(target);
  else if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return `x-scheme-handler/${new URL(target).protocol.slice(0,-1)}`;
  return (await run("xdg-mime",["query","filetype",path.resolve(target)])).trim();
}

export async function getApplications(target) {
  const entries = JSON.parse(await run(bridge().launcherPath,["applications"]));
  let applications = entries.map(entry => ({name:entry.title,localizedName:entry.title,bundleId:entry.id.replace(/^app:/,"").replace(/\.desktop$/,""),path:entry.action.Desktop}));
  if (target !== undefined) {
    const mime = await mimeType(target);
    applications = (await Promise.all(applications.map(async app => {
      const source = await fs.readFile(app.path,"utf8").catch(()=>"");
      const types = source.split(/\r?\n/).find(line => line.startsWith("MimeType="))?.slice(9).split(";") || [];
      return types.includes(mime) ? app : null;
    }))).filter(Boolean);
  }
  return applications;
}

export async function getDefaultApplication(target) {
  const mime = await mimeType(target);
  const desktop = (await run("xdg-mime",["query","default",mime])).trim();
  if (!desktop) throw new Error(`No application is associated with ${mime}`);
  const apps = await getApplications();
  const installed = apps.find(app => path.basename(app.path) === desktop || `${app.bundleId}.desktop` === desktop);
  if (installed) return installed;
  const directories = [process.env.XDG_DATA_HOME || path.join(process.env.HOME,".local/share"),...(process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":")];
  for (const directory of directories) {
    const file = path.join(directory,"applications",desktop);
    const source = await fs.readFile(file,"utf8").catch(()=>null);
    if (source) {
      const name = source.match(/^Name=(.+)$/m)?.[1] || desktop.replace(/\.desktop$/,"");
      return {name,localizedName:name,path:file,bundleId:desktop.replace(/\.desktop$/,"")};
    }
  }
  throw new Error(`The default application ${desktop} is not installed`);
}

export async function getFrontmostApplication() {
  const previous = JSON.parse(process.env.COMMAND_SPACE_FRONTMOST || "null");
  const active = previous || JSON.parse(await run("hyprctl",["-j","activewindow"]));
  const apps = await getApplications();
  const app = apps.find(app => app.bundleId?.toLowerCase() === active.class?.toLowerCase());
  return {name:active.class,bundleId:active.class,path:"",...app,pid:active.pid};
}
