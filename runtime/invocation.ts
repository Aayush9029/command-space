import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import React from "react";
import { build } from "esbuild";
import { createRenderer } from "./renderer.ts";
import { SetupForm } from "./setup.ts";
import { aiAvailable } from "./ai.ts";
import { browserAvailable } from "./browser.ts";
import { readStore, updateStore } from "./storage.ts";
import { extensionManifest } from "./manifest.ts";
import { errorMessage, inputMessage, protocolLines, type LaunchMessage, type WireMessage } from "./protocol.ts";
import { isRecord, recordValue, type AIConfig, type RuntimeContext, type ValueRecord } from "./types.ts";

const runtimePath = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const emit = (message: WireMessage): void => { process.stdout.write(`${JSON.stringify(message)}\n`); };
for (const key of ["log", "info", "debug", "warn"] as const) console[key] = (...args: unknown[]) => console.error(...args);
const renderer = createRenderer(emit);
let stack: React.ReactNode[] = [];
let popCallbacks: (() => void)[] = [];
const renderStack = () => renderer.render(React.createElement(React.Fragment, null,
  ...stack.map((element, index) => React.createElement("NavigationPage", { key: index, active: index === stack.length - 1 }, element))));
let requestId = 0;
const pending = new Map<string, { resolve(value: unknown): void; reject(reason: unknown): void }>();
const context: RuntimeContext = {
  emit,
  environment: { commandName: "", extensionName: "", ownerOrAuthorName: "", assetsPath: "", supportPath: "", isDevelopment: false, appearance: "dark", textSize: "medium", raycastVersion: "1.0.0", commandMode: "view", launchType: "userInitiated", canAccess: () => false },
  extensionPath: "",
  preferencesPanel() { throw new Error("Extension preferences are unavailable before launch"); },
  preferences: {},
  ai: aiConfiguration(process.env.SUPER_SPACE_AI_CONFIG),
  launcherPath: process.env.SUPER_SPACE_BINARY || "super-space",
  formValues: values => renderer.formValues(values),
  storedFormValues: values => renderer.storedFormValues(values),
  push(element, onPop) { stack.push(element); popCallbacks.push(onPop ?? (() => {})); renderStack(); },
  pop() { if (stack.length > 1) { stack.pop(); popCallbacks.pop()?.(); renderStack(); } else emit({ type: "pop" }); },
  root() { while (stack.length > 1) { stack.pop(); popCallbacks.pop()?.(); } renderStack(); },
  async request<T = unknown>(kind: string, options: ValueRecord, signal?: AbortSignal): Promise<T> {
    const id = String(++requestId);
    const response = await new Promise<unknown>((resolve, reject) => {
      const abort = (): void => {
        pending.delete(id);
        emit({type:"cancel-request", id});
        reject(signal?.reason ?? new Error("Request canceled"));
      };
      if (signal?.aborted) { reject(signal.reason); return; }
      signal?.addEventListener("abort", abort, {once:true});
      const cleanup = (): void => { signal?.removeEventListener("abort", abort); };
      pending.set(id, { resolve(value) { cleanup(); resolve(value); }, reject(reason) { cleanup(); reject(reason); } });
      try { emit({ type: "request", kind, id, options }); }
      catch (error) { pending.delete(id); cleanup(); reject(error); }
    });
    return response as T;
  },
};
globalThis.__superSpace = context;

function aiConfiguration(source: string | undefined): AIConfig {
  const value: unknown = JSON.parse(source || "{}");
  if (!isRecord(value)) throw new Error("AI configuration must be an object");
  if (value.endpoint !== undefined && typeof value.endpoint !== "string") throw new Error("Invalid AI endpoint");
  if (value.model !== undefined && typeof value.model !== "string") throw new Error("Invalid AI model");
  let models: Record<string, string> | undefined;
  if (value.models !== undefined) {
    if (!isRecord(value.models)) throw new Error("Invalid AI models");
    models = Object.fromEntries(Object.entries(value.models).map(([key, model]) => {
      if (typeof model !== "string") throw new Error("Invalid AI model");
      return [key, model];
    }));
  }
  return { endpoint: value.endpoint, model: value.model, models };
}

async function launch(options: LaunchMessage): Promise<void> {
  const extensionPath = path.resolve(options.extension);
  const manifest = extensionManifest(JSON.parse(await fs.readFile(path.join(extensionPath, "package.json"), "utf8")));
  const command = manifest.commands.find(command => command.name === options.command);
  if (!command) throw new Error(`Command ${options.command} is not declared in package.json`);
  const home = process.env.HOME || homedir();
  const supportRoot = path.resolve(process.env.XDG_DATA_HOME || path.join(home, ".local/share"), "super-space", "extension-data");
  const support = path.resolve(supportRoot, manifest.name);
  if (!support.startsWith(`${supportRoot}${path.sep}`)) throw new Error("Extension name escapes its storage directory");
  await fs.mkdir(support, { recursive: true, mode: 0o700 });
  const stored = readStore(path.join(support, "preferences.json"));
  const definitions = [...manifest.preferences, ...command.preferences];
  const preferences: ValueRecord = {
    ...Object.fromEntries(definitions.filter(field => field.default !== undefined).map(field => [field.name, field.default])),
    ...recordValue(stored.extension ?? stored),
    ...recordValue(recordValue(stored.commands)[command.name]),
    ...options.preferences,
  };
  context.preferences = preferences;
  context.extensionPath = extensionPath;
  context.environment = { commandName: command.name, extensionName: manifest.name, ownerOrAuthorName: manifest.owner || manifest.author || "", assetsPath: path.join(extensionPath, "assets"), supportPath: support, isDevelopment: process.env.SUPER_SPACE_DEVELOPMENT === "1", appearance: process.env.SUPER_SPACE_APPEARANCE || "dark", textSize: "medium", raycastVersion: "1.0.0", commandMode: command.mode || "view", launchType: options.launchType || "userInitiated", canAccess: capability => isRecord(capability) && (capability.__superSpaceCapability === "windows" || (capability.__superSpaceCapability === "ai" && aiAvailable()) || (capability.__superSpaceCapability === "browser" && browserAvailable())) };
  context.preferencesPanel = () => {
    const panel = React.createElement(SetupForm, { title: `${manifest.title || manifest.name} Preferences`, fields: definitions, values: preferences, submitTitle: "Save Preferences", onSubmit: async values => {
      const extensionValues = Object.fromEntries(manifest.preferences.map(field => [field.name, values[field.name]]));
      const commandValues = Object.fromEntries(command.preferences.map(field => [field.name, values[field.name]]));
      updateStore(path.join(support, "preferences.json"), current => {
        current.extension = extensionValues;
        current.commands = { ...recordValue(current.commands), [command.name]: commandValues };
      });
      emit({type:"relaunch",options:{ ...options, openPreferences: false, setupComplete: false }});
    } });
    context.push(panel);
  };
  if (options.openPreferences || definitions.some(field => field.required && (preferences[field.name] === undefined || preferences[field.name] === ""))) {
    context.preferencesPanel(); return;
  }
  const missingArguments = command.arguments.some(field => field.required && (options.arguments?.[field.name] === undefined || options.arguments[field.name] === "" || options.arguments[field.name] === null));
  if (command.arguments.length && !options.setupComplete && (missingArguments || (options.arguments == null && options.launchType !== "background"))) {
    stack = [React.createElement(SetupForm, { title: command.title, fields: command.arguments, values: options.arguments || {}, submitTitle: "Run Command", onSubmit: async arguments_ => {
      emit({type:"relaunch",options:{ ...options, arguments: arguments_, setupComplete: true }});
    } })];
    popCallbacks = []; renderStack(); return;
  }
  const candidates = command.path ? [path.resolve(extensionPath, command.path)] : ["tsx", "ts", "jsx", "js", "mjs"].map(ext => path.join(extensionPath, "src", `${command.name}.${ext}`));
  const entry = candidates.find(file => fsSync.existsSync(file));
  if (!entry || !entry.startsWith(`${extensionPath}${path.sep}`)) throw new Error(`Source file missing for ${command.name}`);
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, platform: "node", format: "cjs", target: "es2023", jsx: "automatic", sourcemap: "inline",
    nodePaths: [path.join(runtimePath, "node_modules")],
    plugins: [{ name: "super-space-api", setup(build) {
      build.onResolve({ filter: /^@raycast\/api$/ }, () => ({ path: path.join(runtimePath, "api.ts") }));
      build.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: require.resolve(args.path), external: true }));
    } }],
  });
  const filename = path.join(extensionPath, `.super-space-${command.name}.cjs`);
  const module: { exports: ValueRecord } = { exports: {} };
  const extensionRequire = createRequire(path.join(extensionPath, "package.json"));
  new Function("require", "module", "exports", "__filename", "__dirname", result.outputFiles[0].text)(extensionRequire, module, module.exports, filename, extensionPath);
  const exported = module.exports.default;
  if (typeof exported !== "function") throw new Error("Extension command must have a default function export");
  const props = { arguments: options.arguments || {}, launchType: context.environment.launchType, launchContext: decodeContext(options.launchContext), fallbackText: options.fallbackText };
  if (command.mode === "no-view") {
    await exported(props); emit({ type: "done" });
  } else {
    stack = [React.createElement(exported as React.ComponentType<typeof props>, props)]; popCallbacks = []; renderStack();
  }
}

function decodeContext(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (!Array.isArray(value) && !isRecord(value)) return value;
  if (Array.isArray(value)) return value.map(decodeContext);
  if (Object.keys(value).length === 2 && typeof value.value === "string") {
    if (value.__superSpaceLaunchValue === "Date") return new Date(value.value);
    if (value.__superSpaceLaunchValue === "Buffer") return Buffer.from(value.value, "base64");
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeContext(item)]));
}

const report = (error: unknown): void => emit({ type: "error", message: errorMessage(error) });
let launched = false;
try {
for await (const line of protocolLines(process.stdin)) {
  try {
    const message = inputMessage(JSON.parse(line));
    if (message.type === "launch" && !launched) {
      launched = true;
      launch(message).catch(report).finally(() => emit({type:"invocation-ready"}));
    }
    else if (message.type === "event") renderer.invoke(message.callback, message.args || [], message).catch(report);
    else if (message.type === "pop") context.pop();
    else if (message.type === "preferences") context.preferencesPanel();
    else if (message.type === "response") { const request = pending.get(message.id); pending.delete(message.id); if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.value); }
    else if (message.type === "stop") break;
  } catch (error) { report(error); }
}
} catch (error) { report(error); }
process.kill(-process.pid,"SIGKILL");
