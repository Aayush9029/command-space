import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const icons = {
  MagnifyingGlass:"", Search:"", Star:"", StarFilled:"", Heart:"", HeartFilled:"", Check:"", CheckCircle:"",
  XMark:"󰅖", XMarkCircle:"", Plus:"", Minus:"", Trash:"󰆴", Pencil:"󰏫", Gear:"", Gearshape:"",
  CopyClipboard:"󰅌", Clipboard:"󰅌", Document:"󰈔", Text:"󰦨", Code:"󰘦", Terminal:"", Folder:"󰉋", Finder:"󰉋",
  Link:"", Globe:"󰖟", Clock:"󰥔", Calendar:"󰃭", Download:"", Upload:"", ArrowClockwise:"",
  ArrowRight:"→", ArrowLeft:"←", ArrowUp:"↑", ArrowDown:"↓", ChevronRight:"›", ChevronLeft:"‹",
  Person:"", PersonCircle:"", Lock:"", Key:"", Eye:"", EyeDisabled:"", Warning:"", Info:"󰋽",
  List:"", Grid:"󰀻", Image:"󰋩", Photo:"󰋩", Video:"", Music:"", Play:"", Pause:"", Stop:"",
  Bolt:"", LightBulb:"󰌵", ColorWheel:"󰏘", Envelope:"", Message:"󰍡", Book:"", Bookmark:"", Hash:"󰘎",
};

export function createImages(onChange) {
  const downloads = new Map();
  const queue = [];
  let running = 0;
  function pump() {
    while (running < 4 && queue.length) {
      const work = queue.shift(); running++;
      work().finally(() => { running--; pump(); });
    }
  }
  function remote(uri, headers) {
    const environment = globalThis.__commandSpace?.environment;
    if (!environment?.supportPath) return uri;
    const key = createHash("sha256").update(JSON.stringify([uri, headers])).digest("hex");
    if (!downloads.has(key)) {
      const folder = path.join(environment.supportPath, "image-cache");
      for (const extension of [".svg", ".jpg", ".webp", ".png"]) {
        const file = path.join(folder, key + extension);
        try {
          const stat = fs.statSync(file);
          if (stat.isFile() && Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) { downloads.set(key, file); return file; }
        } catch {}
      }
      downloads.set(key, "󰋩");
      queue.push(async () => {
        try {
          const response = await fetch(uri, { headers, signal:AbortSignal.timeout(15000) });
          if (!response.ok || !response.body) throw new Error("Image download failed");
          const type = response.headers.get("content-type") || "";
          const extension = type.includes("svg") ? ".svg" : type.includes("jpeg") ? ".jpg" : type.includes("webp") ? ".webp" : ".png";
          const file = path.join(folder, key + extension);
          const chunks = []; let size = 0;
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > 16 * 1024 * 1024) throw new Error("Image is too large");
            chunks.push(chunk);
          }
          fs.mkdirSync(folder, { recursive:true, mode:0o700 });
          fs.writeFileSync(file, Buffer.concat(chunks), { mode:0o600 });
          downloads.set(key, file);
          onChange();
        } catch { downloads.set(key, "󰋩"); }
      });
      pump();
    }
    return downloads.get(key);
  }
  function image(value) {
    if (typeof value === "string") {
      if (value.startsWith("icon:")) return icons[value.slice(5)] || "󰏗";
      if (/^https?:\/\//.test(value)) return remote(value);
      if (value.startsWith("file://")) { try { return decodeURIComponent(new URL(value).pathname); } catch { return "󰋩"; } }
      const assets = globalThis.__commandSpace?.environment?.assetsPath;
      if (assets && value && !path.isAbsolute(value)) {
        try { if (fs.statSync(path.join(assets,value)).isFile()) return path.join(assets,value); } catch {}
      }
      return value;
    }
    if (!value || typeof value !== "object") return value;
    if (value.light || value.dark) return image(value[globalThis.__commandSpace?.environment?.appearance || "dark"] || value.light || value.dark);
    if (value.uri) return remote(value.uri, value.headers);
    if (value.source) return { ...value, source:image(value.source) };
    return value;
  }
  return props => Object.fromEntries(Object.entries(props).map(([key, value]) => [key, ["icon", "content", "image"].includes(key) ? image(value) : value]));
}
