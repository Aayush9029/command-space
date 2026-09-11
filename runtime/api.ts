import React from "react";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Clipboard } from "./clipboard.ts";
import {getApplications} from "./applications.ts";
import {readStore, updateStore} from "./storage.ts";

import { getRuntimeContext, recordValue, isRecord, errorCode, type NativeProps, type RuntimeEnvironment, type ValueRecord } from "./types.ts";

const bridge = getRuntimeContext;
type Callback = () => unknown;
type HostComponent<P extends NativeProps = NativeProps> = React.FC<P> & { hostType: string };
export interface CommonProps extends NativeProps {
  id?: string;
  title?: string;
  subtitle?: string;
  icon?: Image.ImageLike;
  navigationTitle?: string;
  isLoading?: boolean;
}
interface SearchProps extends CommonProps {
  searchText?: string;
  searchBarPlaceholder?: string;
  onSearchTextChange?: (value: string) => unknown;
  selectedItemId?: string | null;
  onSelectionChange?: (id: string | null) => unknown;
  filtering?: boolean | { keepSectionOrder?: boolean };
  throttle?: boolean;
  isShowingDetail?: boolean;
}
interface DropdownProps extends CommonProps {
  value?: string;
  defaultValue?: string;
  storeValue?: boolean;
  onChange?: (value: string) => unknown;
}
interface ActionProps extends CommonProps {
  shortcut?: Keyboard.Shortcut;
  style?: string;
  onAction?: Callback;
}
interface FormItemProps<T> extends CommonProps {
  id: string;
  value?: T;
  defaultValue?: T;
  onChange?: (value: T) => unknown;
  onFocus?: (event: Form.Event<T>) => unknown;
  onBlur?: (event: Form.Event<T>) => unknown;
  error?: string;
  storeValue?: boolean;
  placeholder?: string;
}

function component<P extends NativeProps = CommonProps>(name: string): HostComponent<P> {
  const Component: HostComponent<P> = props => {
    const { children, actions, detail, metadata, searchBarAccessory, ...rest } = { ...props } as NativeProps;
    const storesDropdown = name === "List.Dropdown" && Boolean(props.storeValue);
    const storesValue = Boolean(props.storeValue && props.id);
    const storageFile = storesDropdown ? "dropdown-values.json" : "form-values.json";
    const storageKey = typeof props.id === "string" && props.id ? props.id : "search";
    const [stored] = React.useState(() => {
      if (!storesValue && !storesDropdown) return undefined;
      const values = readStorage(path.join(bridge().environment.supportPath, storageFile));
      return storageValue(recordValue(storageValue(values, bridge().environment.commandName)), storageKey);
    });
    if ((storesValue || storesDropdown) && stored !== undefined && rest.value === undefined) rest.defaultValue = stored;
    if (storesDropdown) {
      const change = rest.onChange;
      rest.onChange = (value: string) => {
        const file = path.join(bridge().environment.supportPath, storageFile);
        const command = bridge().environment.commandName;
        updateStore(file, data => { setStorageValue(data, command, {...recordValue(storageValue(data, command)), [storageKey]:value}); });
        return typeof change === "function" ? change(value) : undefined;
      };
    }
    if (name === "Form.DatePicker" && typeof rest.onChange === "function") {
      const change = rest.onChange;
      rest.onChange = (value: string | null) => {
        const date = value ? new Date(value) : null;
        if (!date || Number.isFinite(date.getTime())) return change(date);
      };
    }
    if (name === "Form.DatePicker") {
      for (const event of ["onFocus", "onBlur"]) {
        const handler = rest[event];
        if (typeof handler === "function") rest[event] = (event: Form.Event<string | null>) => handler({...event, target:{...event.target, value:event.target.value ? new Date(event.target.value) : null}});
      }
    }
    return React.createElement(name, rest, children, actions, detail, metadata, searchBarAccessory);
  };
  Component.hostType = name;
  Component.displayName = name;
  return Component;
}
const Dropdown = Object.assign(component<DropdownProps>("List.Dropdown"), {
  Item: component<CommonProps & { value: string }>("List.Dropdown.Item"),
  Section: component("List.Dropdown.Section"),
});
export const Detail = Object.assign(component("Detail"), {
  Metadata: Object.assign(component("Detail.Metadata"), {
    Label: component("Detail.Metadata.Label"),
    Link: component("Detail.Metadata.Link"),
    Separator: component("Detail.Metadata.Separator"),
    TagList: Object.assign(component("Detail.Metadata.TagList"), { Item: component("Detail.Metadata.TagList.Item") }),
  }),
});
export const List = Object.assign(component<SearchProps>("List"), {
  Item: Object.assign(component("List.Item"), { Detail: Object.assign(component("Detail"), { Metadata: Detail.Metadata }) }),
  Section: component("List.Section"),
  EmptyView: component("List.EmptyView"),
  Dropdown,
});
export const Grid = Object.assign(component<SearchProps>("Grid"), {
  Item: component("Grid.Item"),
  Section: component("Grid.Section"),
  EmptyView: List.EmptyView,
  Dropdown: List.Dropdown,
  ItemSize: { Small: "small", Medium: "medium", Large: "large" },
  Inset: { Zero: "zero", Small: "sm", Medium: "md", Large: "lg" },
  Fit: { Contain: "contain", Fill: "fill" },
  AspectRatio: { One: "1", ThreeToTwo: "3/2", TwoToThree: "2/3", FourToThree: "4/3", ThreeToFour: "3/4", SixteenToNine: "16/9", NineToSixteen: "9/16" },
});
export const Form = Object.assign(component("Form"), {
  TextField: component<FormItemProps<string>>("Form.TextField"),
  PasswordField: component<FormItemProps<string>>("Form.PasswordField"),
  TextArea: component<FormItemProps<string>>("Form.TextArea"),
  Checkbox: component<FormItemProps<boolean> & { label: string }>("Form.Checkbox"),
  DatePicker: component<FormItemProps<Date | null>>("Form.DatePicker"),
  Dropdown: Object.assign(component<FormItemProps<string>>("Form.Dropdown"), {
    Item: component<CommonProps & { value: string }>("Form.Dropdown.Item"),
    Section: component("Form.Dropdown.Section"),
  }),
  TagPicker: Object.assign(component<FormItemProps<string[]>>("Form.TagPicker"), { Item: component<CommonProps & { value: string }>("Form.TagPicker.Item") }),
  FilePicker: component<FormItemProps<string[]>>("Form.FilePicker"),
  Description: component<CommonProps & { text: string }>("Form.Description"),
  Separator: component("Form.Separator"),
});
export namespace Form {
  export type Values = ValueRecord;
  export interface Item { focus(): void; reset(): void }
  export type TextField = Item;
  export type PasswordField = Item;
  export type TextArea = Item;
  export type Checkbox = Item;
  export type DatePicker = Item;
  export type Dropdown = Item;
  export type TagPicker = Item;
  export type FilePicker = Item;
  export interface Event<T> { type: string; target: { id: string; value: T } }
  export type ItemProps<T> = FormItemProps<T>;
  export type TextFieldProps = FormItemProps<string>;
  export type FilePickerProps = FormItemProps<string[]>;
}
export const ActionPanel = Object.assign(component("ActionPanel"), {
  Section: component("ActionPanel.Section"),
  Submenu: component("ActionPanel.Submenu"),
});
function SubmitForm<T extends object = Form.Values>({ onSubmit, ...props }: ActionProps & { onSubmit?: (values: T) => unknown }) {
  return React.createElement("Action.SubmitForm", { title: "Submit", ...props, onAction: async (values: ValueRecord) => {
    const stored = bridge().storedFormValues(values);
    const {supportPath, commandName} = bridge().environment;
    // The extension supplies the form value shape through its component's generic parameter.
    const result = await onSubmit?.(bridge().formValues(values) as T);
    if (result !== false && Object.keys(stored).length) {
      const file = path.join(supportPath, "form-values.json");
      updateStore(file, data => { setStorageValue(data, commandName, {...recordValue(storageValue(data, commandName)), ...stored}); });
    }
    return result;
  } });
}
const BaseAction = component<ActionProps>("Action");
type ClipboardContent = Parameters<typeof Clipboard.copy>[0];
export const Action = Object.assign(BaseAction, {
  Style: { Regular: "regular", Destructive: "destructive" },
  CopyToClipboard: ({ content, concealed, onCopy, ...props }: ActionProps & { content: ClipboardContent; concealed?: boolean; onCopy?: (content: ClipboardContent) => unknown }) => React.createElement(BaseAction, { title: "Copy to Clipboard", ...props, onAction: async () => { await Clipboard.copy(content, {concealed}); await onCopy?.(content); } }),
  OpenInBrowser: ({ url, onOpen, ...props }: ActionProps & { url: string; onOpen?: Callback }) => React.createElement(BaseAction, { title: "Open in Browser", ...props, onAction: async () => { await open(url); await onOpen?.(); } }),
  Open: ({ target, application, onOpen, ...props }: ActionProps & { target: string; application?: string; onOpen?: Callback }) => React.createElement(BaseAction, { title: "Open", ...props, onAction: async () => { await open(target, application); await onOpen?.(); } }),
  ShowInFinder: ({ path, ...props }: ActionProps & { path: string }) => React.createElement(BaseAction, { title: "Show in File Manager", ...props, onAction: () => showInFinder(path) }),
  Paste: ({ content, onPaste, ...props }: ActionProps & { content: Parameters<typeof Clipboard.paste>[0]; onPaste?: Callback }) => React.createElement(BaseAction, { title: "Paste", ...props, onAction: async () => { await Clipboard.paste(content); await onPaste?.(); } }),
  Push: ({ target, onPush, ...props }: ActionProps & { target: React.ReactNode; onPush?: Callback }) => React.createElement(BaseAction, { title: "Open", ...props, onAction: () => { bridge().push(target); onPush?.(); } }),
  SubmitForm,
  Trash: ({ paths, ...props }: ActionProps & { paths: string | string[] }) => React.createElement(BaseAction, { title: "Move to Trash", ...props, onAction: () => trash(paths) }),
});
export function useNavigation() { return { push: (element: React.ReactNode, onPop?: () => void) => bridge().push(element, onPop), pop: () => bridge().pop() }; }

export const environment = new Proxy({} as RuntimeEnvironment, { get: (_, key) => Reflect.get(globalThis.__superSpace?.environment ?? {}, key) });
export const LaunchType = { UserInitiated: "userInitiated", Background: "background" };
export const LaunchContext = {};
export type LaunchContext = ValueRecord;
export interface LaunchProps<T extends { arguments?: object; launchContext?: object } = { arguments: ValueRecord; launchContext: ValueRecord }> {
  arguments: T["arguments"];
  launchContext?: T["launchContext"];
  launchType: string;
  fallbackText?: string;
}
export const Keyboard = { Shortcut: { Common: { Copy: { modifiers: ["cmd"], key: "c" }, Paste: { modifiers: ["cmd"], key: "v" }, Open: { modifiers: ["cmd"], key: "o" }, Refresh: { modifiers: ["cmd"], key: "r" }, Remove: { modifiers: ["ctrl"], key: "x" } } } };
export namespace Keyboard {
  export interface Shortcut { modifiers: readonly string[]; key: string }
}
export const Color = Object.fromEntries(["Blue", "Red", "Green", "Yellow", "Orange", "Purple", "Magenta", "PrimaryText", "SecondaryText"].map(x => [x, x.toLowerCase()]));
export const Icon = new Proxy<Record<string, string>>({}, { get: (_, name) => `icon:${String(name)}` });
export const Image = { Mask: { Circle: "circle", RoundedRectangle: "roundedRectangle" } };
export namespace Image {
  export type ImageLike = string | { source: string | { light: string; dark: string }; tintColor?: string; mask?: string } | { fileIcon: string };
}
export function getPreferenceValues<T extends object = ValueRecord>(): T { return { ...bridge().preferences } as T; }
export async function updateCommandMetadata(metadata: { subtitle?: string | null }) {
  const file = path.join(bridge().environment.supportPath, "command-metadata.json");
  updateStore(file, values => { setStorageValue(values, bridge().environment.commandName, {subtitle:metadata.subtitle}); });
  bridge().emit({type:"metadata",...metadata});
}
export async function openExtensionPreferences() { bridge().preferencesPanel(); }
export async function openCommandPreferences() { bridge().preferencesPanel(); }
export async function closeMainWindow() { bridge().emit({ type: "close" }); }
export async function popToRoot() { bridge().root(); }
export async function clearSearchBar() { bridge().emit({ type: "clear-search" }); }
export async function showHUD(title: string) { bridge().emit({ type: "toast", title }); }
export const Toast = { Style: { Animated: "animated", Success: "success", Failure: "failure" } };
export interface ToastOptions extends ValueRecord {
  title: string;
  style?: string;
  message?: string;
  primaryAction?: { title: string; onAction: (toast: ToastHandle) => unknown };
  secondaryAction?: { title: string; onAction: (toast: ToastHandle) => unknown };
}
export interface ToastHandle extends ToastOptions { hide(): Promise<void>; show(): Promise<void> }
export namespace Toast {
  export type Options = ToastOptions;
  export type Style = string;
}
export async function showToast(options: ToastOptions | string, title?: string, message?: string): Promise<ToastHandle> {
  const value: ToastOptions = typeof options === "string" ? { style: options, title: title ?? "", message } : { ...options };
  const emit = () => bridge().emit({ type: "toast", ...value });
  emit();
  const handle: ToastHandle = { ...value, hide: async () => bridge().emit({ type: "toast", title: "" }), show: async () => emit() };
  return new Proxy(handle, {
    set: (_target, key, next: unknown) => { Reflect.set(value, key, next); emit(); return true; },
    get: (target, key) => key === "hide" || key === "show" ? Reflect.get(target, key) : Reflect.get(value, key),
  });
}

const storagePath = () => path.join(bridge().environment.supportPath, "storage.json");
function readStorage(file = storagePath()) { return readStore(file); }
function storageValue(values: ValueRecord, key: string): unknown { return Object.hasOwn(values, key) ? values[key] : undefined; }
function setStorageValue(values: ValueRecord, key: string, value: unknown): void {
  Object.defineProperty(values, key, { value, configurable: true, enumerable: true, writable: true });
}
export const LocalStorage = {
  async getItem<T = unknown>(key: string): Promise<T | undefined> { return storageValue(readStorage(), key) as T | undefined; },
  async setItem(key: string, value: unknown) { updateStore(storagePath(), data => { setStorageValue(data, key, value); }); },
  async removeItem(key: string) { updateStore(storagePath(), data => { delete data[key]; }); },
  async allItems<T extends object = ValueRecord>(): Promise<T> { return readStorage() as T; },
  async clear() { updateStore(storagePath(), data => { for (const key of Object.keys(data)) delete data[key]; }); },
};
export class Cache {
  readonly namespace: string;
  readonly file: string;
  constructor(options: { namespace?: string } = {}) {
    this.namespace = options.namespace || "default";
    this.file = path.join(bridge().environment.supportPath, "cache.json");
  }
  read() { return recordValue(storageValue(readStorage(this.file), this.namespace)); }
  change<T>(update: (values: ValueRecord) => T): T { return updateStore(this.file, data => { const values = recordValue(storageValue(data, this.namespace)); setStorageValue(data, this.namespace, values); return update(values); }); }
  get(key: string): string | undefined { const value = storageValue(this.read(), key); return typeof value === "string" ? value : undefined; }
  has(key: string) { return this.get(key) !== undefined; }
  get isEmpty() { return Object.keys(this.read()).length === 0; }
  set(key: string, value: string) { this.change(data => { setStorageValue(data, key, value); }); }
  remove(key: string) { return this.change(data => { const had = Object.hasOwn(data, key); delete data[key]; return had; }); }
  clear() { this.change(data => { for (const key of Object.keys(data)) delete data[key]; }); }
  subscribe(callback: () => void) {
    fsSync.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = fsSync.watch(path.dirname(this.file), (_event, filename) => {
      if (filename !== path.basename(this.file)) return;
      clearTimeout(timer); timer = setTimeout(callback, 20);
    });
    watcher.unref();
    return () => { clearTimeout(timer); watcher.close(); };
  }
}

function run(program: string, args: string[], input?: string, detached = false): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(program, args, { detached, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout?.on("data", data => { stdout += data; });
    child.stderr?.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.stdin?.on("error", reject);
    child.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `${program} exited ${code}`)));
    if (input !== undefined) child.stdin?.end(input);
  });
}
export { Clipboard } from "./clipboard.ts";
export async function open(target: string, application?: string) {
  if (application && !application.includes("/")) {
    const apps = await getApplications();
    application = apps.find(app => app.bundleId === application || path.basename(app.path) === application)?.path || application;
  }
  if (application?.endsWith(".desktop")) return run("gio", ["launch", application, target], undefined, true);
  if (application) return run(application, [target], undefined, true);
  return run("xdg-open", [target], undefined, true);
}
export async function showInFinder(target: string) { return run("xdg-open", [path.dirname(target)], undefined, true); }
export async function trash(paths: string | string[]) { for (const item of Array.isArray(paths) ? paths : [paths]) await run("gio", ["trash", item]); }
export async function getSelectedText() { return run("wl-paste", ["--primary", "--no-newline", "--type", "text"]); }
export async function getSelectedFinderItems() { throw new Error("The active file manager does not expose selected files through the Linux desktop portal"); }
export {getApplications, getDefaultApplication, getFrontmostApplication} from "./applications.ts";
export interface LaunchCommandOptions extends ValueRecord {
  name: string;
  extensionName?: string;
  ownerOrAuthorName?: string;
  type?: string;
  arguments?: ValueRecord;
  context?: unknown;
}
export async function launchCommand(options: LaunchCommandOptions) {
  const extensionName = options.extensionName || bridge().environment.extensionName;
  if (!/^[\w-]+$/.test(options.name || "") || !/^[\w-]+$/.test(extensionName)) throw new Error("Extension and command names must contain only letters, digits, underscores, or hyphens");
  const directory = extensionName === bridge().environment.extensionName ? bridge().extensionPath : path.join(path.dirname(bridge().extensionPath), extensionName);
  let manifest: unknown;
  try { manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8")); }
  catch (error) { if (errorCode(error) === "ENOENT") throw new Error(`Extension command is not installed: ${extensionName}/${options.name}`); throw error; }
  if (!isRecord(manifest) || !Array.isArray(manifest.commands) || !manifest.commands.some((command: unknown) => isRecord(command) && command.name === options.name)) throw new Error(`Extension command is not installed: ${extensionName}/${options.name}`);
  if (options.ownerOrAuthorName && options.ownerOrAuthorName !== (manifest.owner || manifest.author)) throw new Error(`The installed ${extensionName} extension has a different owner or author`);
  if (options.type && !Object.values(LaunchType).includes(options.type)) throw new Error(`Invalid command launch type: ${options.type}`);
  const launchContext = encodeContext(options.context);
  bridge().emit({ ...options, context: undefined, type: "launch-command", launchType: options.type || LaunchType.UserInitiated, launchContext, extensionName });
}

function encodeContext(value: unknown, ancestors = new Set<object>()): unknown {
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return { __superSpaceLaunchValue: "Date", value: value.toISOString() };
  if (Buffer.isBuffer(value)) return { __superSpaceLaunchValue: "Buffer", value: value.toString("base64") };
  if (ancestors.has(value)) throw new Error("Command launch context must be JSON serializable");
  ancestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) return value.map(item => encodeContext(item, ancestors));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeContext(item, ancestors)]));
}
export interface AlertOptions extends ValueRecord {
  title: string;
  message?: string;
  icon?: Image.ImageLike;
  primaryAction?: { title: string; style?: string; onAction?: Callback };
  dismissAction?: { title: string; onAction?: Callback };
}
export async function confirmAlert(options: AlertOptions) {
  const accepted = await bridge().request<boolean>("confirm", options);
  await (accepted ? options.primaryAction : options.dismissAction)?.onAction?.();
  return accepted;
}
export const Alert = { ActionStyle: Action.Style };
export { OAuth } from "./oauth.ts";
export { AI } from "./ai.ts";
export async function getCalendarEvents() { throw new Error("This extension requires the macOS Calendar API"); }
export { BrowserExtension } from "./browser.ts";
export { WindowManagement } from "./windows.ts";
export const MenuBarExtra = Object.assign(component("MenuBarExtra"), {
  Item: component<ActionProps>("MenuBarExtra.Item"),
  Section: component("MenuBarExtra.Section"),
  Submenu: component("MenuBarExtra.Submenu"),
  Separator: component("MenuBarExtra.Separator"),
});
export const showInFileManager = showInFinder;
