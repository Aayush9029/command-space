import React from "react";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Clipboard } from "./clipboard.mjs";
import {getApplications} from "./applications.mjs";
import {readStore, updateStore} from "./storage.mjs";

const bridge = () => globalThis.__superSpace;
const component = name => {
  const Component = props => {
    const { children, actions, detail, metadata, searchBarAccessory, ...rest } = props;
    const storesDropdown = name === "List.Dropdown" && Boolean(props.storeValue);
    const storesValue = Boolean(props.storeValue && props.id);
    const storageFile = storesDropdown ? "dropdown-values.json" : "form-values.json";
    const storageKey = props.id || "search";
    const [stored] = React.useState(() => {
      if (!storesValue && !storesDropdown) return undefined;
      const values = readStorage(path.join(bridge().environment.supportPath, storageFile));
      return values[bridge().environment.commandName]?.[storageKey];
    });
    if ((storesValue || storesDropdown) && stored !== undefined && rest.value === undefined) rest.defaultValue = stored;
    if (storesDropdown) {
      const change = rest.onChange;
      rest.onChange = value => {
        const file = path.join(bridge().environment.supportPath, storageFile);
        const command = bridge().environment.commandName;
        updateStore(file, data => { data[command] = {...data[command], [storageKey]:value}; });
        return change?.(value);
      };
    }
    if (name === "Form.DatePicker" && rest.onChange) {
      const change = rest.onChange;
      rest.onChange = value => { const date = value ? new Date(value) : null; if (!date || Number.isFinite(date.getTime())) return change(date); };
    }
    if (name === "Form.DatePicker") {
      for (const event of ["onFocus", "onBlur"]) {
        const handler = rest[event];
        if (handler) rest[event] = event => handler({...event, target:{...event.target, value:event.target.value ? new Date(event.target.value) : null}});
      }
    }
    return React.createElement(name, rest, children, actions, detail, metadata, searchBarAccessory);
  };
  Component.hostType = name;
  Component.displayName = name;
  return Component;
};
export const List = component("List");
List.Item = component("List.Item");
List.Section = component("List.Section");
List.EmptyView = component("List.EmptyView");
List.Dropdown = component("List.Dropdown");
List.Dropdown.Item = component("List.Dropdown.Item");
List.Dropdown.Section = component("List.Dropdown.Section");
List.Item.Detail = component("Detail");
export const Detail = component("Detail");
Detail.Metadata = component("Detail.Metadata");
for (const type of ["Label", "Link", "Separator", "TagList"]) Detail.Metadata[type] = component(`Detail.Metadata.${type}`);
Detail.Metadata.TagList.Item = component("Detail.Metadata.TagList.Item");
List.Item.Detail.Metadata = Detail.Metadata;
export const Grid = component("Grid");
Grid.Item = component("Grid.Item");
Grid.Section = component("Grid.Section");
Grid.EmptyView = List.EmptyView;
Grid.Dropdown = List.Dropdown;
Grid.ItemSize = { Small: "small", Medium: "medium", Large: "large" };
Grid.Inset = { Zero: "zero", Small: "sm", Medium: "md", Large: "lg" };
Grid.Fit = { Contain: "contain", Fill: "fill" };
Grid.AspectRatio = { One: "1", ThreeToTwo: "3/2", TwoToThree: "2/3", FourToThree: "4/3", ThreeToFour: "3/4", SixteenToNine: "16/9", NineToSixteen: "9/16" };
export const Form = component("Form");
for (const type of ["TextField", "PasswordField", "TextArea", "Checkbox", "DatePicker", "Dropdown", "TagPicker", "FilePicker", "Description", "Separator"]) Form[type] = component(`Form.${type}`);
Form.Dropdown.Item = component("Form.Dropdown.Item");
Form.Dropdown.Section = component("Form.Dropdown.Section");
Form.TagPicker.Item = component("Form.TagPicker.Item");
export const ActionPanel = component("ActionPanel");
ActionPanel.Section = component("ActionPanel.Section");
ActionPanel.Submenu = component("ActionPanel.Submenu");
export const Action = component("Action");
Action.Style = { Regular: "regular", Destructive: "destructive" };
Action.CopyToClipboard = ({ content, concealed, onCopy, ...props }) => React.createElement(Action, { title: "Copy to Clipboard", ...props, onAction: async () => { await Clipboard.copy(content, {concealed}); await onCopy?.(content); } });
Action.OpenInBrowser = ({ url, onOpen, ...props }) => React.createElement(Action, { title: "Open in Browser", ...props, onAction: async () => { await open(url); await onOpen?.(); } });
Action.Open = ({ target, application, onOpen, ...props }) => React.createElement(Action, { title: "Open", ...props, onAction: async () => { await open(target, application); await onOpen?.(); } });
Action.ShowInFinder = ({ path, ...props }) => React.createElement(Action, { title: "Show in File Manager", ...props, onAction: () => showInFinder(path) });
Action.Paste = ({ content, onPaste, ...props }) => React.createElement(Action, { title: "Paste", ...props, onAction: async () => { await Clipboard.paste(content); await onPaste?.(); } });
Action.Push = ({ target, onPush, ...props }) => React.createElement(Action, { title: "Open", ...props, onAction: () => { bridge().push(target); onPush?.(); } });
Action.SubmitForm = ({ onSubmit, ...props }) => React.createElement("Action.SubmitForm", { title: "Submit", ...props, onAction: async values => {
  const stored = bridge().storedFormValues(values);
  const {supportPath, commandName} = bridge().environment;
  const result = await onSubmit?.(bridge().formValues(values));
  if (result !== false && Object.keys(stored).length) {
    const file = path.join(supportPath, "form-values.json");
    updateStore(file, data => { data[commandName] = {...data[commandName], ...stored}; });
  }
  return result;
} });
Action.Trash = ({ paths, ...props }) => React.createElement(Action, { title: "Move to Trash", ...props, onAction: () => trash(paths) });
export function useNavigation() { return { push: (element, onPop) => bridge().push(element, onPop), pop: () => bridge().pop() }; }

export const environment = new Proxy({}, { get: (_, key) => bridge()?.environment?.[key] });
export const LaunchType = { UserInitiated: "userInitiated", Background: "background" };
export const LaunchContext = {};
export const Keyboard = { Shortcut: { Common: { Copy: { modifiers: ["cmd"], key: "c" }, Paste: { modifiers: ["cmd"], key: "v" }, Open: { modifiers: ["cmd"], key: "o" }, Refresh: { modifiers: ["cmd"], key: "r" }, Remove: { modifiers: ["ctrl"], key: "x" } } } };
export const Color = Object.fromEntries(["Blue", "Red", "Green", "Yellow", "Orange", "Purple", "Magenta", "PrimaryText", "SecondaryText"].map(x => [x, x.toLowerCase()]));
export const Icon = new Proxy({}, { get: (_, name) => `icon:${String(name)}` });
export const Image = { Mask: { Circle: "circle", RoundedRectangle: "roundedRectangle" } };
export function getPreferenceValues() { return { ...bridge().preferences }; }
export async function updateCommandMetadata(metadata) {
  const file = path.join(bridge().environment.supportPath, "command-metadata.json");
  updateStore(file, values => { values[bridge().environment.commandName] = {subtitle:metadata.subtitle}; });
  bridge().emit({type:"metadata",...metadata});
}
export async function openExtensionPreferences() { bridge().preferencesPanel(); }
export async function openCommandPreferences() { bridge().preferencesPanel(); }
export async function closeMainWindow() { bridge().emit({ type: "close" }); }
export async function popToRoot() { bridge().root(); }
export async function clearSearchBar() { bridge().emit({ type: "clear-search" }); }
export async function showHUD(title) { bridge().emit({ type: "toast", title }); }
export const Toast = { Style: { Animated: "animated", Success: "success", Failure: "failure" } };
export async function showToast(options, title, message) {
  const value = typeof options === "string" ? { style: options, title, message } : { ...options };
  const emit = () => bridge().emit({ type: "toast", ...value });
  emit();
  return new Proxy({ hide: async () => bridge().emit({ type: "toast", title: "" }), show: async () => emit() }, { set: (target, key, value_) => { value[key] = value_; emit(); return true; }, get: (target, key) => target[key] ?? value[key] });
}

const storagePath = () => path.join(bridge().environment.supportPath, "storage.json");
function readStorage(file = storagePath()) { return readStore(file); }
export const LocalStorage = {
  async getItem(key) { return readStorage()[key]; },
  async setItem(key, value) { updateStore(storagePath(), data => { data[key] = value; }); },
  async removeItem(key) { updateStore(storagePath(), data => { delete data[key]; }); },
  async allItems() { return readStorage(); },
  async clear() { updateStore(storagePath(), data => { for (const key of Object.keys(data)) delete data[key]; }); },
};
export class Cache {
  constructor(options = {}) {
    this.namespace = options.namespace || "default";
    this.file = path.join(bridge().environment.supportPath, "cache.json");
  }
  read() { return readStorage(this.file)[this.namespace] || {}; }
  change(update) { return updateStore(this.file, data => { data[this.namespace] ||= {}; return update(data[this.namespace]); }); }
  get(key) { return this.read()[key]; }
  has(key) { return this.get(key) !== undefined; }
  get isEmpty() { return Object.keys(this.read()).length === 0; }
  set(key, value) { this.change(data => { data[key] = value; }); }
  remove(key) { return this.change(data => { const had = key in data; delete data[key]; return had; }); }
  clear() { this.change(data => { for (const key of Object.keys(data)) delete data[key]; }); }
  subscribe(callback) {
    fsSync.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    let timer;
    const watcher = fsSync.watch(path.dirname(this.file), (_event, filename) => {
      if (filename !== path.basename(this.file)) return;
      clearTimeout(timer); timer = setTimeout(callback, 20);
    });
    watcher.unref();
    return () => { clearTimeout(timer); watcher.close(); };
  }
}

function run(program, args, input, detached = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { detached, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `${program} exited ${code}`)));
    if (input !== undefined) child.stdin.end(input);
  });
}
export { Clipboard } from "./clipboard.mjs";
export async function open(target, application) {
  if (application && !application.includes("/")) {
    const apps = await getApplications();
    application = apps.find(app => app.bundleId === application || path.basename(app.path) === application)?.path || application;
  }
  if (application?.endsWith(".desktop")) return run("gio", ["launch", application, target], undefined, true);
  if (application) return run(application, [target], undefined, true);
  return run("xdg-open", [target], undefined, true);
}
export async function showInFinder(target) { return run("xdg-open", [path.dirname(target)], undefined, true); }
export async function trash(paths) { for (const item of Array.isArray(paths) ? paths : [paths]) await run("gio", ["trash", item]); }
export async function getSelectedText() { return run("wl-paste", ["--primary", "--no-newline", "--type", "text"]); }
export async function getSelectedFinderItems() { throw new Error("The active file manager does not expose selected files through the Linux desktop portal"); }
export {getApplications, getDefaultApplication, getFrontmostApplication} from "./applications.mjs";
export async function launchCommand(options) {
  const extensionName = options.extensionName || bridge().environment.extensionName;
  if (!/^[\w-]+$/.test(options.name || "") || !/^[\w-]+$/.test(extensionName)) throw new Error("Extension and command names must contain only letters, digits, underscores, or hyphens");
  const directory = extensionName === bridge().environment.extensionName ? bridge().extensionPath : path.join(path.dirname(bridge().extensionPath), extensionName);
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") throw new Error(`Extension command is not installed: ${extensionName}/${options.name}`); throw error; }
  if (!manifest.commands?.some(command => command.name === options.name)) throw new Error(`Extension command is not installed: ${extensionName}/${options.name}`);
  if (options.ownerOrAuthorName && options.ownerOrAuthorName !== (manifest.owner || manifest.author)) throw new Error(`The installed ${extensionName} extension has a different owner or author`);
  if (options.type && !Object.values(LaunchType).includes(options.type)) throw new Error(`Invalid command launch type: ${options.type}`);
  const launchContext = encodeContext(options.context);
  bridge().emit({ ...options, context: undefined, type: "launch-command", launchType: options.type || LaunchType.UserInitiated, launchContext, extensionName });
}

function encodeContext(value, ancestors = new Set()) {
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return { __superSpaceLaunchValue: "Date", value: value.toISOString() };
  if (Buffer.isBuffer(value)) return { __superSpaceLaunchValue: "Buffer", value: value.toString("base64") };
  if (ancestors.has(value)) throw new Error("Command launch context must be JSON serializable");
  ancestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) return value.map(item => encodeContext(item, ancestors));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeContext(item, ancestors)]));
}
export async function confirmAlert(options) {
  const accepted = await bridge().request("confirm", options);
  await (accepted ? options.primaryAction : options.dismissAction)?.onAction?.();
  return accepted;
}
export const Alert = { ActionStyle: Action.Style };
export { OAuth } from "./oauth.mjs";
export { AI } from "./ai.mjs";
export async function getCalendarEvents() { throw new Error("This extension requires the macOS Calendar API"); }
export { BrowserExtension } from "./browser.mjs";
export { WindowManagement } from "./windows.mjs";
export const MenuBarExtra = component("MenuBarExtra");
MenuBarExtra.Item = component("MenuBarExtra.Item");
MenuBarExtra.Section = component("MenuBarExtra.Section");
MenuBarExtra.Submenu = component("MenuBarExtra.Submenu");
MenuBarExtra.Separator = component("MenuBarExtra.Separator");
export const showInFileManager = showInFinder;
