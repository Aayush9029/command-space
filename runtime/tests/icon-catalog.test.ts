import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { iconCatalog, iconRawValues, iconCatalogVersion, resolveIcon } from "../icon-catalog.ts";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

test("the bundled catalog covers the complete published Raycast 2.2.1 icon inventory", () => {
  const inventory = Object.entries(iconRawValues).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  assert.equal(iconCatalogVersion, "2.2.1");
  assert.equal(inventory.length, 478);
  assert.equal(digest(inventory.map(([name, value]) => `${name}=${value}`).join("\n")),
    "6f7d7e2063719b9828aedf6403d27ae30e06128b54c97c7f0f33d4957c9de38d");
  for (const [name, value] of inventory) {
    assert.equal(resolveIcon(name), iconCatalog[name], name);
    assert.equal(resolveIcon(`icon:${name}`), iconCatalog[name], name);
    assert.equal(resolveIcon(value), iconCatalog[name], value);
    assert.equal(resolveIcon(`icon:${value}`), iconCatalog[name], value);
  }
});

test("every icon resolves to a bundled, font-independent symbolic SVG", () => {
  const directory = fileURLToPath(new URL("../icons/", import.meta.url));
  for (const source of new Set(Object.values(iconCatalog))) {
    assert.ok(path.isAbsolute(source));
    assert.ok(!path.relative(directory, source).startsWith(".."));
    const svg = fs.readFileSync(source, "utf8");
    assert.match(svg, /^<svg\b/);
    assert.match(svg, /viewBox="0 0 256 256"/);
    assert.match(svg, /currentColor/);
    assert.match(svg, /<(?:path|circle|rect|g)\b/);
    assert.doesNotMatch(svg, /<(?:script|foreignObject|image|text)\b|\bhref=|\bon\w+=/i);
    assert.ok(svg.length < 32 * 1024);
  }
  for (const value of [null, undefined, 1, {}, "icon:Missing", "toString", "__proto__", "../icons/star.svg"])
    assert.equal(resolveIcon(value), null);
});

test("number, progress, filled and disabled variants retain distinct artwork", () => {
  const artwork = (name: string) => { const file = resolveIcon(name); assert.ok(file); return digest(fs.readFileSync(file)); };
  assert.equal(new Set(Array.from({length: 100}, (_, index) => artwork(`Number${String(index).padStart(2, "0")}`))).size, 100);
  assert.equal(new Set(["CircleProgress", "CircleProgress25", "CircleProgress50", "CircleProgress75", "CircleProgress100"].map(artwork)).size, 5);
  for (const [regular, variant] of [
    ["Airplane", "AirplaneFilled"], ["ArrowDownCircle", "ArrowDownCircleFilled"],
    ["Heart", "HeartFilled"], ["Heart", "HeartDisabled"], ["Star", "StarFilled"],
    ["Star", "StarDisabled"], ["ChevronDown", "ChevronDownSmall"],
    ["Alarm", "AlarmRinging"], ["SpeakerDown", "SpeakerLow"],
    ["AppWindowGrid2x2", "AppWindowGrid3x3"], ["MoonUp", "Moonrise"],
    ["RaycastLogoNeg", "RaycastLogoPos"],
  ]) assert.notEqual(artwork(regular), artwork(variant), `${regular} and ${variant}`);
  for (const alias of ["Search", "StarFilled", "HeartFilled", "Gearshape", "Hash", "Grid", "Photo", "XMark", "ColorWheel"])
    assert.ok(resolveIcon(alias), alias);
});

test("launcher and bundled extension icon references all resolve", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const references = new Set<string>();
  function scan(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "target") continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (/\.(rs|tsx?|json)$/.test(entry.name)) {
        for (const [, name] of fs.readFileSync(file, "utf8").matchAll(/icon:([A-Za-z0-9]+)/g)) {
          references.add(name);
          assert.ok(resolveIcon(name), `${path.relative(root, file)} refers to unknown icon ${name}`);
        }
      }
    }
  }
  scan(path.join(root, "src/linux"));
  scan(path.join(root, "extensions"));
  assert.ok(references.size > 40);
  const diagonals = ["ArrowUpLeft", "ArrowUpRight", "ArrowDownLeft", "ArrowDownRight"];
  assert.equal(new Set(diagonals.map(name => (() => { const file = resolveIcon(name); assert.ok(file); return digest(fs.readFileSync(file)); })())).size, 4);
});
