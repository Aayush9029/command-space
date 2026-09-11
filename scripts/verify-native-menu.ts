import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

interface NativeRow {
  title: string;
  subtitle: string;
  action: { Shell?: string; Menu?: string };
}

interface Plugin {
  id: string;
  enabled: boolean;
  canDisable: boolean;
  firstParty: boolean;
  clonedFrom?: string;
}

function record(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Expected an object");
}

const binary = process.argv[2] || "./target/debug/super-space";
const exec = (command: string, args: string[] = []) => execFileSync(command, args, { encoding: "utf8", timeout: 60000, maxBuffer: 80 * 1024 * 1024 }).trim();
const shell = (command: string) => exec("bash", ["-lc", command]);
function rows(route: string): NativeRow[] {
  const value: unknown = JSON.parse(exec(binary, ["menu", "provider", route]));
  assert.ok(Array.isArray(value), `Expected rows for ${route}`);
  return (value as unknown[]).map(item => {
    record(item);
    assert.ok(typeof item.title === "string" && typeof item.subtitle === "string");
    record(item.action);
    const action: NativeRow["action"] = {};
    for (const key of ["Shell", "Menu"] as const) {
      const entry: unknown = item.action[key];
      if (entry !== undefined) {
        assert.equal(typeof entry, "string");
        assert.ok(typeof entry === "string");
        action[key] = entry;
      }
    }
    return { title: item.title, subtitle: item.subtitle, action };
  });
}
function shellAction(row: NativeRow): string {
  assert.ok(typeof row.action.Shell === "string", `Expected shell action for ${row.title}`);
  return row.action.Shell;
}
function menuAction(row: NativeRow): string {
  assert.ok(typeof row.action.Menu === "string", `Expected menu action for ${row.title}`);
  return row.action.Menu;
}
const titles = (items: NativeRow[]) => items.map(item => item.title.replace(/ ✓$/, ""));
const lines = (text: string) => text.split("\n").filter(Boolean);
const report: Record<string, number> = {};

for (const [route, command] of Object.entries({
  "learn.keybindings": "omarchy-menu-keybindings",
  "learn.tmux-keybindings": "omarchy-menu-tmux-keybindings",
  "learn.herdr-keybindings": "omarchy-menu-herdr-keybindings",
})) {
  const actual = rows(route);
  const expected = lines(shell(`${command} --print`)).filter(line => line.includes("→"));
  assert.deepEqual(titles(actual), expected.map(line => line.split("→").slice(1).join("→").trim()), route);
  assert.deepEqual(actual.map(item => item.subtitle), expected.map(line => line.split("→")[0].trim()), route);
  if (route === "learn.keybindings") {
    assert(actual.length > 10, "Read the running compositor's bindings inside its desktop session");
    assert(actual.every(item => item.action.Shell?.includes("export -f omarchy-menu-select")));
  }
  report[route] = actual.length;
}

const pluginValues: unknown = JSON.parse(shell("omarchy-plugin-list --json"));
assert.ok(Array.isArray(pluginValues), "Expected the installed plugin list");
const plugins: Plugin[] = (pluginValues as unknown[]).map(value => {
  record(value);
  assert.ok(typeof value.id === "string");
  assert.ok(typeof value.enabled === "boolean" && typeof value.canDisable === "boolean" && typeof value.firstParty === "boolean");
  assert.ok(value.clonedFrom === undefined || value.clonedFrom === null || typeof value.clonedFrom === "string");
  return { id: value.id, enabled: value.enabled, canDisable: value.canDisable, firstParty: value.firstParty, clonedFrom: value.clonedFrom ?? undefined };
});
for (const operation of ["enable", "disable", "clone", "remove"] as const) {
  const route = `setup.plugin.${operation}`;
  const actual = rows(route);
  const expected = plugins.filter(plugin => ({
    enable: !plugin.enabled,
    disable: plugin.enabled && plugin.canDisable,
    clone: plugin.firstParty && !plugins.some(other => other.clonedFrom === plugin.id),
    remove: !plugin.firstParty,
  })[operation]);
  assert.deepEqual(actual.map(item => item.subtitle), expected.map(plugin => plugin.id), route);
  if (operation === "remove" && actual.length) {
    assert(menuAction(actual[0]).startsWith("native-confirm:"));
    const confirmation = rows(menuAction(actual[0]));
    assert.equal(confirmation[0].title, "Cancel");
    assert(shellAction(confirmation[1]).includes("omarchy-plugin-remove"));
  }
  report[route] = actual.length;
}

for (const [route, command] of Object.entries({
  "install.package": "pacman -Slq | sort -u",
  "install.aur": "yay -Slqa | sort -u",
  "remove.package": "pacman -Qqe | sort -u",
})) {
  const actual = rows(route);
  const expected = lines(shell(command));
  assert.deepEqual(titles(actual).sort(), expected.sort(), route);
  if (route === "remove.package") {
    assert(actual.every(item => item.action.Menu?.startsWith("native-confirm:")));
    const confirmation = rows(menuAction(actual[0]));
    assert(shellAction(confirmation[1]).includes("pacman -Rns"));
    assert(!shellAction(confirmation[1]).includes("--noconfirm"));
  } else {
    assert(actual.every(item => item.action.Shell && !/\|\s*fzf\b/.test(item.action.Shell)));
  }
  report[route] = actual.length;
}

const themes = rows("style.theme");
assert.deepEqual(titles(themes), lines(shell("omarchy-theme-list")));
assert(themes.every(item => shellAction(item).startsWith("omarchy-theme-set ")));
report["style.theme"] = themes.length;
const unlock = rows("style.unlock");
assert.equal(unlock.length, lines(shell("omarchy-plymouth-list")).length + 1);
assert.equal(unlock[0].title.replace(/ ✓$/, ""), "Default");
report["style.unlock"] = unlock.length;
const backgrounds = rows("style.background");
assert(backgrounds.length > 0);
assert(backgrounds.every(item => shellAction(item).startsWith("omarchy-theme-bg-set ")));
report["style.background"] = backgrounds.length;
const timezones = rows("update.timezone");
assert.deepEqual(titles(timezones), lines(exec("timedatectl", ["list-timezones"])));
report["update.timezone"] = timezones.length;
const databases = rows("install.development.docker-dbs");
const databaseOptions = shell("source <(sed -n '/^options=/p' \"$(command -v omarchy-install-docker-dbs)\"); printf '%s\\n' \"${options[@]}\"");
assert.deepEqual(titles(databases), lines(databaseOptions));
assert(databases.every(item => shellAction(item).includes("omarchy-install-docker-dbs")));
report["install.development.docker-dbs"] = databases.length;
console.log(JSON.stringify({ nativeMenuRows: report, mutationActionsExecuted: false }, null, 2));
