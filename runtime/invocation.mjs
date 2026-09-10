import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import readline from "node:readline";
import React from "react";
import { build } from "esbuild";
import { createRenderer } from "./renderer.mjs";
import { SetupForm } from "./setup.mjs";
import { aiAvailable } from "./ai.mjs";
import { browserAvailable } from "./browser.mjs";
import { updateStore } from "./storage.mjs";

const runtimePath = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const emit = message => process.stdout.write(`${JSON.stringify(message)}\n`);
for (const key of ["log", "info", "debug", "warn"]) console[key] = (...args) => console.error(...args);
const renderer = createRenderer(emit);
let stack = [];
let popCallbacks = [];
const renderStack = () => renderer.render(React.createElement(React.Fragment, null,
  ...stack.map((element, index) => React.createElement("NavigationPage", { key: index, active: index === stack.length - 1 }, element))));
let requestId = 0;
const pending = new Map();
globalThis.__commandSpace = {
  emit,
  environment: {},
  preferences: {},
  ai: JSON.parse(process.env.COMMAND_SPACE_AI_CONFIG || "{}"),
  launcherPath: process.env.COMMAND_SPACE_BINARY || "command-space",
  formValues: values => renderer.formValues(values),
  storedFormValues: values => renderer.storedFormValues(values),
  push(element, onPop) { stack.push(element); popCallbacks.push(onPop); renderStack(); },
  pop() { if (stack.length > 1) { stack.pop(); popCallbacks.pop()?.(); renderStack(); } else emit({ type: "pop" }); },
  root() { while (stack.length > 1) { stack.pop(); popCallbacks.pop()?.(); } renderStack(); },
  request(kind, options, signal) {
    const id = String(++requestId);
    return new Promise((resolve, reject) => {
      const abort = () => { pending.delete(id); emit({type:"cancel-request", id}); reject(signal.reason || new Error("Request canceled")); };
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", abort, {once:true});
      const finish = callback => value => { signal?.removeEventListener("abort", abort); callback(value); };
      pending.set(id, { resolve:finish(resolve), reject:finish(reject) });
      emit({ type: "request", kind, id, options });
    });
  },
};

async function launch(options) {
  const extensionPath = path.resolve(options.extension);
  const manifest = JSON.parse(await fs.readFile(path.join(extensionPath, "package.json"), "utf8"));
  const command = manifest.commands?.find(command => command.name === options.command);
  if (!command) throw new Error(`Command ${options.command} is not declared in package.json`);
  const home = process.env.HOME;
  const support = path.join(process.env.XDG_DATA_HOME || path.join(home, ".local/share"), "command-space", "extension-data", manifest.name);
  await fs.mkdir(support, { recursive: true, mode: 0o700 });
  const preferences = {};
  let stored = {};
  try { stored = JSON.parse(await fs.readFile(path.join(support, "preferences.json"), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const definitions = [...(manifest.preferences || []), ...(command.preferences || [])];
  for (const preference of [...(manifest.preferences || []), ...(command.preferences || [])]) if (preference.default !== undefined) preferences[preference.name] = preference.default;
  Object.assign(preferences, stored.extension || stored, stored.commands?.[command.name] || {});
  Object.assign(preferences, options.preferences || {});
  globalThis.__commandSpace.preferences = preferences;
  globalThis.__commandSpace.extensionPath = extensionPath;
  globalThis.__commandSpace.environment = { commandName: command.name, extensionName: manifest.name, ownerOrAuthorName: manifest.owner || manifest.author || "", assetsPath: path.join(extensionPath, "assets"), supportPath: support, isDevelopment: process.env.COMMAND_SPACE_DEVELOPMENT === "1", appearance: process.env.COMMAND_SPACE_APPEARANCE || "dark", textSize: "medium", raycastVersion: "1.0.0", commandMode: command.mode || "view", launchType: options.launchType || "userInitiated", canAccess: capability => capability?.__commandSpaceCapability === "windows" || (capability?.__commandSpaceCapability === "ai" && aiAvailable()) || (capability?.__commandSpaceCapability === "browser" && browserAvailable()) };
  globalThis.__commandSpace.preferencesPanel = () => {
    const panel = React.createElement(SetupForm, { title: `${manifest.title || manifest.name} Preferences`, fields: definitions, values: preferences, submitTitle: "Save Preferences", onSubmit: async values => {
      const extensionValues = Object.fromEntries((manifest.preferences || []).map(field => [field.name, values[field.name]]));
      const commandValues = Object.fromEntries((command.preferences || []).map(field => [field.name, values[field.name]]));
      updateStore(path.join(support, "preferences.json"), current => {
        current.extension = extensionValues;
        current.commands = { ...(current.commands || {}), [command.name]: commandValues };
      });
      emit({type:"relaunch",options:{ ...options, openPreferences: false, setupComplete: false }});
    } });
    globalThis.__commandSpace.push(panel);
  };
  if (options.openPreferences || definitions.some(field => field.required && (preferences[field.name] === undefined || preferences[field.name] === ""))) {
    globalThis.__commandSpace.preferencesPanel(); return;
  }
  const missingArguments = command.arguments?.some(field => field.required && (options.arguments?.[field.name] === undefined || options.arguments[field.name] === "" || options.arguments[field.name] === null));
  if (command.arguments?.length && !options.setupComplete && (missingArguments || (options.arguments == null && options.launchType !== "background"))) {
    stack = [React.createElement(SetupForm, { title: command.title, fields: command.arguments, values: options.arguments || {}, submitTitle: "Run Command", onSubmit: async arguments_ => {
      emit({type:"relaunch",options:{ ...options, arguments: arguments_, setupComplete: true }});
    } })];
    popCallbacks = []; renderStack(); return;
  }
  const candidates = command.path ? [path.resolve(extensionPath, command.path)] : ["tsx", "ts", "jsx", "js", "mjs"].map(ext => path.join(extensionPath, "src", `${command.name}.${ext}`));
  const entry = candidates.find(file => fsSync.existsSync(file));
  if (!entry || !entry.startsWith(`${extensionPath}${path.sep}`)) throw new Error(`Source file missing for ${command.name}`);
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, platform: "node", format: "cjs", target: "node22", jsx: "automatic", sourcemap: "inline",
    nodePaths: [path.join(runtimePath, "node_modules")],
    plugins: [{ name: "command-space-api", setup(build) {
      build.onResolve({ filter: /^@raycast\/api$/ }, () => ({ path: path.join(runtimePath, "api.mjs") }));
      build.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: require.resolve(args.path), external: true }));
    } }],
  });
  const filename = path.join(extensionPath, `.command-space-${command.name}.cjs`);
  const module = { exports: {} };
  const extensionRequire = createRequire(path.join(extensionPath, "package.json"));
  new Function("require", "module", "exports", "__filename", "__dirname", result.outputFiles[0].text)(extensionRequire, module, module.exports, filename, extensionPath);
  const exported = module.exports.default;
  if (typeof exported !== "function") throw new Error("Extension command must have a default function export");
  const props = { arguments: options.arguments || {}, launchType: globalThis.__commandSpace.environment.launchType, launchContext: decodeContext(options.launchContext), fallbackText: options.fallbackText };
  if (command.mode === "no-view") {
    await exported(props); emit({ type: "done" });
  } else {
    stack = [React.createElement(exported, props)]; popCallbacks = []; renderStack();
  }
}

function decodeContext(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decodeContext);
  if (Object.keys(value).length === 2 && typeof value.value === "string") {
    if (value.__commandSpaceLaunchValue === "Date") return new Date(value.value);
    if (value.__commandSpaceLaunchValue === "Buffer") return Buffer.from(value.value, "base64");
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeContext(item)]));
}

const input = readline.createInterface({ input: process.stdin });
const report = error => emit({ type: "error", message: error.stack || String(error) });
let launched = false;
for await (const line of input) {
  try {
    if (line.length > 1024 * 1024) throw new Error("Extension input exceeds one megabyte");
    const message = JSON.parse(line);
    if (message.type === "launch" && !launched) {
      launched = true;
      launch(message).catch(report).finally(() => emit({type:"invocation-ready"}));
    }
    else if (message.type === "event") renderer.invoke(message.callback, message.args || [], message).catch(report);
    else if (message.type === "pop") globalThis.__commandSpace.pop();
    else if (message.type === "preferences") globalThis.__commandSpace.preferencesPanel();
    else if (message.type === "response") { const request = pending.get(message.id); pending.delete(message.id); if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.value); }
    else if (message.type === "stop") break;
  } catch (error) { report(error); }
}
process.kill(-process.pid,"SIGKILL");
