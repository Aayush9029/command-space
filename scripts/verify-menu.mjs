import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";

const omarchy = process.env.OMARCHY_PATH || "/usr/share/omarchy";
const binary = process.argv[2] || "./target/debug/command-space";
const context = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(omarchy, "shell/plugins/menu/MenuModel.js"), "utf8"), context);
const model = context.module.exports;
const custom = path.join(process.env.HOME, ".config/omarchy/extensions/omarchy-menu.jsonc");
const defaults = model.parseMenuJsonc(fs.readFileSync(path.join(omarchy, "default/omarchy/omarchy-menu.jsonc"), "utf8"));
const stock = model.mergeMenuSources(defaults, []);
const source = model.mergeMenuSources(defaults, model.parseMenuJsonc(fs.existsSync(custom) ? fs.readFileSync(custom, "utf8") : ""));
const nativePickers = new Set([
  "learn.keybindings", "learn.tmux-keybindings", "learn.herdr-keybindings",
  "style.theme", "style.background", "style.unlock", "update.timezone",
  "setup.plugin.enable", "setup.plugin.disable", "setup.plugin.clone", "setup.plugin.remove",
  "install.package", "install.aur", "remove.package", "remove.theme", "remove.webapp", "remove.tui",
  "install.development.docker-dbs", "trigger.capture.screenrecord.webcam",
]);
const nativeWorkflows = {
  "install.webapp": "install-web-app", "install.tui": "install-tui",
  "trigger.reminder.set": "reminder", "trigger.reminder.show": "reminders", "trigger.reminder.clear": "clear-reminders",
  "trigger.transcode": "transcode", "trigger.share.file": "share-files", "trigger.share.folder": "share-folder",
  "style.about.image": "about-image", "style.screensaver.image": "screensaver-image", "install.style.background": "install-wallpaper",
  "install.style.theme": "install-theme", "setup.plugin.add": "add-shell-plugin", "install.gaming.retro-launcher": "install-retro-game",
  "setup.network.dns.custom": "custom-dns", "setup.security.sshd": "setup-sshd", "install.windows": "install-windows", "update.password.drive": "drive-password",
  "style.about.text": "about-text", "style.screensaver.text": "screensaver-text", "style.about.default": "about-reset", "style.screensaver.default": "screensaver-reset",
};
const native = JSON.parse(execFileSync(binary, ["menu", "inspect"], { encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 }));
const fields = ["id", "parent", "icon", "iconFont", "label", "title", "target", "description", "action", "provider", "aliases", "when", "checked"];
assert.deepEqual(native.items.map(item => item.id), Array.from(source.itemOrder).filter(id => id !== "root"));
for (const item of native.items) {
  for (const field of fields) assert.deepEqual(JSON.parse(JSON.stringify(item[field])), JSON.parse(JSON.stringify(source.items[item.id][field])), `${item.id}.${field}`);
}
for (const [route, rows] of Object.entries(native.routes)) {
  const target = source.items[route]?.target || route;
  const expected = Array.from(source.itemOrder).map(id => source.items[id]).filter(item => item.parent === target && model.isVisible(source.items, source.itemOrder, native.conditions, item, 0));
  assert.deepEqual(rows.map(row => row.id), expected.map(item => item.id), `Children of ${route}`);
  for (const row of rows) {
    const item = source.items[row.id];
    assert.equal(row.title, model.labelFor(item, native.checks), `Label of ${item.id}`);
    if (item.action && item.action === stock.items[item.id]?.action && nativePickers.has(item.id)) {
      assert.deepEqual(row.action, { Menu: item.id }, `Native picker for ${item.id}`);
    } else if (item.action && item.action === stock.items[item.id]?.action && nativeWorkflows[item.id]) {
      assert.deepEqual(row.action, { Extension: { extension: "omarchy-tools", command: nativeWorkflows[item.id] } }, `Native workflow for ${item.id}`);
    } else if (item.action === "omarchy-menu-emoji") assert.deepEqual(row.action, { Builtin: "emoji" }, `Native emoji for ${item.id}`);
    else if (item.action) assert.equal(row.action.Shell, item.action, `Action of ${item.id}`);
    else assert.equal(row.action.Menu, item.target || item.id, `Target of ${item.id}`);
  }
}
console.log(`Matched ${native.items.length} Omarchy definitions and ${Object.keys(native.routes).length} routes, including native picker and workflow adaptations.`);
