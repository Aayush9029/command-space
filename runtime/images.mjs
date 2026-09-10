import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { resolveIcon } from "./icon-catalog.mjs";

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const CACHE_AGE = 24 * 60 * 60 * 1000;
const IMAGE_EXTENSIONS = [".svg", ".jpg", ".webp", ".png", ".gif", ".ico", ".bmp"];

function imageType(bytes) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 && width <= 4096 && height <= 4096 ? ".png" : null;
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return ".jpg";
  if (bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return ".webp";
  if (bytes.length >= 14 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6)) && bytes.at(-1) === 59) {
    const width = bytes.readUInt16LE(6), height = bytes.readUInt16LE(8);
    return width > 0 && height > 0 && width <= 4096 && height <= 4096 ? ".gif" : null;
  }
  if (bytes.length >= 22 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1) {
    const count = bytes.readUInt16LE(4);
    if (!count || count > 256 || bytes.length < 6 + count * 16) return null;
    for (let index = 0; index < count; index++) {
      const length = bytes.readUInt32LE(14 + index * 16), offset = bytes.readUInt32LE(18 + index * 16);
      if (!length || offset < 6 + count * 16 || offset + length > bytes.length) return null;
    }
    return ".ico";
  }
  if (bytes.length >= 54 && bytes.toString("ascii", 0, 2) === "BM" && bytes.readUInt32LE(14) >= 40) {
    const width = bytes.readInt32LE(18), height = Math.abs(bytes.readInt32LE(22));
    return width > 0 && height > 0 && width <= 4096 && height <= 4096 && bytes.readUInt32LE(10) < bytes.length ? ".bmp" : null;
  }
  const text = bytes.toString("utf8").trim();
  if (/^(?:\uFEFF)?(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b/i.test(text) && /(?:<\/svg\s*>|\/>)\s*$/i.test(text)) return ".svg";
  return null;
}

function prune(folder, current) {
  let files;
  try {
    files = fs.readdirSync(folder).filter(name => /^[a-f0-9]{64}\.(svg|jpg|webp|png|gif|ico|bmp)$/.test(name)).map(name => {
      const file = path.join(folder, name), stat = fs.statSync(file);
      return { file, bytes: stat.size, modified: stat.mtimeMs };
    }).sort((a, b) => a.modified - b.modified);
  } catch { return; }
  let bytes = files.reduce((sum, file) => sum + file.bytes, 0), count = files.length;
  for (const file of files) {
    if (file.file === current || (count <= 256 && bytes <= MAX_CACHE_BYTES && Date.now() - file.modified < CACHE_AGE)) continue;
    try { fs.unlinkSync(file.file); bytes -= file.bytes; count--; } catch {}
  }
}

function store(folder, key, bytes) {
  const extension = imageType(bytes);
  if (!extension) throw new Error("Response is not a supported image");
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, key + extension);
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try { fs.writeFileSync(temporary, bytes, { mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
  prune(folder, file);
  return file;
}

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
  function remember(key, source, age = CACHE_AGE) {
    downloads.delete(key);
    while (downloads.size >= 512) downloads.delete(downloads.keys().next().value);
    downloads.set(key, { source, expires: Date.now() + age });
  }
  function remote(uri, headers) {
    const environment = globalThis.__commandSpace?.environment;
    if (!environment?.supportPath) return null;
    const key = createHash("sha256").update(JSON.stringify([uri, Object.entries(headers || {}).sort(([a], [b]) => a.localeCompare(b))])).digest("hex");
    const cached = downloads.get(key);
    if (cached && cached.expires > Date.now() && (!cached.source || cached.source === "󰋩" || fs.existsSync(cached.source))) return cached.source;
    const folder = path.join(environment.supportPath, "image-cache");
    for (const extension of IMAGE_EXTENSIONS) {
      const file = path.join(folder, key + extension);
      try {
        const stat = fs.statSync(file);
        if (stat.isFile() && stat.size <= MAX_IMAGE_BYTES && Date.now() - stat.mtimeMs < CACHE_AGE && imageType(fs.readFileSync(file))) {
          remember(key, file, CACHE_AGE - (Date.now() - stat.mtimeMs));
          return file;
        }
      } catch {}
    }
    if (queue.length >= 128) { remember(key, null, 1000); return null; }
    remember(key, "󰋩", 30000);
    queue.push(async () => {
      try {
        const response = await fetch(uri, { headers, signal: AbortSignal.timeout(15000) });
        if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) throw new Error("Image download failed");
        const chunks = []; let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > MAX_IMAGE_BYTES) throw new Error("Image is too large");
          chunks.push(chunk);
        }
        remember(key, store(folder, key, Buffer.concat(chunks)));
      } catch { remember(key, null, 60000); }
      onChange();
    });
    pump();
    return "󰋩";
  }
  function embedded(uri) {
    const match = uri.match(/^data:image\/(svg\+xml|png|jpeg|webp|gif|(?:x-)?icon|vnd\.microsoft\.icon|(?:x-ms-)?bmp)(;base64)?,([\s\S]*)$/);
    if (!match || uri.length > 24 * 1024 * 1024) return null;
    try {
      const bytes = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]));
      const support = globalThis.__commandSpace?.environment?.supportPath;
      if (!support) return null;
      const extension = imageType(bytes);
      if (!extension) return null;
      const key = createHash("sha256").update(bytes).digest("hex");
      const folder = path.join(support, "image-cache"), file = path.join(folder, key + extension);
      return fs.existsSync(file) ? file : store(folder, key, bytes);
    } catch { return null; }
  }
  function image(value, fallback) {
    if (typeof value === "string") {
      const icon = resolveIcon(value);
      if (icon) return { source: icon, tintColor: "primarytext" };
      if (value.startsWith("icon:")) return { source: resolveIcon("QuestionMarkCircle"), tintColor: "secondarytext" };
      if (/^https?:\/\//.test(value)) return remote(value) ?? (fallback ? image(fallback) : "󰋩");
      if (value.startsWith("data:image/")) return embedded(value) ?? (fallback ? image(fallback) : "󰋩");
      if (value.startsWith("file://")) { try { return decodeURIComponent(new URL(value).pathname); } catch { return "󰋩"; } }
      const assets = globalThis.__commandSpace?.environment?.assetsPath;
      if (assets && value && !path.isAbsolute(value)) {
        try { if (fs.statSync(path.join(assets, value)).isFile()) return path.join(assets, value); } catch {}
      }
      return value;
    }
    if (!value || typeof value !== "object") return value;
    if (value.light || value.dark) return image(value[globalThis.__commandSpace?.environment?.appearance || "dark"] || value.light || value.dark, fallback);
    if (value.uri) return remote(value.uri, value.headers) ?? image(value.fallback || fallback || "󰋩");
    if (value.source) {
      const resolved = image(value.source, value.fallback);
      return { ...(typeof resolved === "object" ? resolved : {}), ...value, source: typeof resolved === "object" ? resolved.source : resolved, fallback: image(value.fallback) };
    }
    return value;
  }
  return props => Object.fromEntries(Object.entries(props).map(([key, value]) => [key,
    ["icon", "content", "image"].includes(key) ? image(value)
      : key === "accessories" && Array.isArray(value) ? value.map(accessory => ({ ...accessory, icon: image(accessory.icon) }))
        : value,
  ]));
}
