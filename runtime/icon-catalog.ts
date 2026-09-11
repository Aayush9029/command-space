import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { isRecord } from "./types.ts";

interface CatalogEntry { asset: string; value?: string | null }
const catalog: unknown = JSON.parse(fs.readFileSync(new URL("./icons/catalog.json", import.meta.url), "utf8"));
if (!isRecord(catalog) || typeof catalog.apiVersion !== "string" || !isRecord(catalog.icons)) throw new Error("Invalid bundled icon catalog");
const entries: [string, CatalogEntry][] = Object.entries(catalog.icons).map(([name, value]) => {
  if (!isRecord(value) || typeof value.asset !== "string" || (value.value != null && typeof value.value !== "string")) throw new Error(`Invalid bundled icon: ${name}`);
  return [name, {asset: value.asset, value: value.value}];
});

export const iconCatalog = Object.freeze(Object.fromEntries(entries.map(([name, icon]) => [
  name, fileURLToPath(new URL(`./icons/${icon.asset}`, import.meta.url)),
])));
export const iconRawValues = Object.freeze(Object.fromEntries(entries
  .flatMap(([name, icon]) => icon.value ? [[name, icon.value]] : [])));
export const iconCatalogVersion = catalog.apiVersion;

const sources = new Map(Object.entries(iconCatalog));
for (const [name, rawValue] of Object.entries(iconRawValues)) sources.set(rawValue, iconCatalog[name]);

export function resolveIcon(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return sources.get(value.startsWith("icon:") ? value.slice(5) : value) ?? null;
}
