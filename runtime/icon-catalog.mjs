import fs from "node:fs";
import { fileURLToPath } from "node:url";

const catalog = JSON.parse(fs.readFileSync(new URL("./icons/catalog.json", import.meta.url), "utf8"));
const entries = Object.entries(catalog.icons);

export const iconCatalog = Object.freeze(Object.fromEntries(entries.map(([name, icon]) => [
  name, fileURLToPath(new URL(`./icons/${icon.asset}`, import.meta.url)),
])));
export const iconRawValues = Object.freeze(Object.fromEntries(entries
  .filter(([, icon]) => icon.value)
  .map(([name, icon]) => [name, icon.value])));
export const iconCatalogVersion = catalog.apiVersion;

const sources = new Map(Object.entries(iconCatalog));
for (const [name, rawValue] of Object.entries(iconRawValues)) sources.set(rawValue, iconCatalog[name]);

export function resolveIcon(value) {
  if (typeof value !== "string") return null;
  return sources.get(value.startsWith("icon:") ? value.slice(5) : value) ?? null;
}
