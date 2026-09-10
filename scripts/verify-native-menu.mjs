import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const binary = process.argv[2] || "./target/debug/command-space";
const exec = (command, args = []) => execFileSync(command, args, { encoding: "utf8", timeout: 60000, maxBuffer: 80 * 1024 * 1024 }).trim();
const shell = command => exec("bash", ["-lc", command]);
const rows = route => JSON.parse(exec(binary, ["menu", "provider", route]));
const titles = items => items.map(item => item.title.replace(/ ✓$/, ""));
const lines = text => text.split("\n").filter(Boolean);
const report = {};

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

const plugins = JSON.parse(shell("omarchy-plugin-list --json"));
for (const operation of ["enable", "disable", "clone", "remove"]) {
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
    assert(actual[0].action.Menu.startsWith("native-confirm:"));
    const confirmation = rows(actual[0].action.Menu);
    assert.equal(confirmation[0].title, "Cancel");
    assert(confirmation[1].action.Shell.includes("omarchy-plugin-remove"));
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
    const confirmation = rows(actual[0].action.Menu);
    assert(confirmation[1].action.Shell.includes("pacman -Rns"));
    assert(!confirmation[1].action.Shell.includes("--noconfirm"));
  } else {
    assert(actual.every(item => item.action.Shell && !/\|\s*fzf\b/.test(item.action.Shell)));
  }
  report[route] = actual.length;
}

const themes = rows("style.theme");
assert.deepEqual(titles(themes), lines(shell("omarchy-theme-list")));
assert(themes.every(item => item.action.Shell.startsWith("omarchy-theme-set ")));
report["style.theme"] = themes.length;
const unlock = rows("style.unlock");
assert.equal(unlock.length, lines(shell("omarchy-plymouth-list")).length + 1);
assert.equal(unlock[0].title.replace(/ ✓$/, ""), "Default");
report["style.unlock"] = unlock.length;
const backgrounds = rows("style.background");
assert(backgrounds.length > 0);
assert(backgrounds.every(item => item.action.Shell.startsWith("omarchy-theme-bg-set ")));
report["style.background"] = backgrounds.length;
const timezones = rows("update.timezone");
assert.deepEqual(titles(timezones), lines(exec("timedatectl", ["list-timezones"])));
report["update.timezone"] = timezones.length;
const databases = rows("install.development.docker-dbs");
const databaseOptions = shell("source <(sed -n '/^options=/p' \"$(command -v omarchy-install-docker-dbs)\"); printf '%s\\n' \"${options[@]}\"");
assert.deepEqual(titles(databases), lines(databaseOptions));
assert(databases.every(item => item.action.Shell.includes("omarchy-install-docker-dbs")));
report["install.development.docker-dbs"] = databases.length;
console.log(JSON.stringify({ nativeMenuRows: report, mutationActionsExecuted: false }, null, 2));
