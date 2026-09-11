import type { BrowserAPI, BrowserContentOptions, BrowserGlobals, BrowserTab, NativePort } from "./types.ts";

const browserGlobals = globalThis as typeof globalThis & BrowserGlobals;
const extensionAPI = browserGlobals.browser ?? browserGlobals.chrome;
if (!extensionAPI) throw new Error("Browser extension API is unavailable");
const api: BrowserAPI = extensionAPI;
let nativePort: NativePort | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retries = 0;
let connected = false;

function reconnect(): void {
  connected = false;
  void badge("!");
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retries));
  retries = Math.min(retries + 1, 5);
}

function disconnected(port: NativePort): void {
  if (nativePort !== port) return;
  nativePort = undefined;
  reconnect();
}

function postMessage(port: NativePort, message: unknown): void {
  if (nativePort !== port) return;
  try { port.postMessage(message); }
  catch {
    disconnected(port);
    try { port.disconnect(); } catch {}
  }
}

function connect(): void {
  if (nativePort) return;
  clearTimeout(retryTimer);
  let port: NativePort;
  try { port = api.runtime.connectNative("com.superspace.bridge"); }
  catch { reconnect(); return; }
  nativePort = port;
  port.onMessage.addListener(message => {
    if (nativePort !== port || !isRecord(message)) return;
    if (message.type === "ready") {
      retries = 0;
      connected = true;
      void badge("");
      return;
    }
    if (typeof message.id !== "string" || !message.id) return;
    const id = message.id;
    void request(message).then(
      result => postMessage(port, { id, result }),
      error => postMessage(port, { id, error: error instanceof Error ? error.message : String(error) }),
    );
  });
  port.onDisconnect.addListener(() => {
    void api.runtime.lastError;
    disconnected(port);
  });
}

async function badge(text: string): Promise<void> {
  try {
    await api.action.setBadgeText({ text });
    await api.action.setBadgeBackgroundColor({ color: "#7aa2f7" });
  } catch {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentOptions(value: unknown): BrowserContentOptions {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("Browser content options must be an object");
  const { format, cssSelector, tabId } = value;
  if (format !== undefined && format !== "html" && format !== "text" && format !== "markdown") {
    throw new Error("Unknown content format");
  }
  if (cssSelector !== undefined && typeof cssSelector !== "string") throw new Error("cssSelector must be a string");
  if (tabId !== undefined && (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 0)) {
    throw new Error("tabId must be a non-negative integer");
  }
  if (cssSelector && (format === undefined || format === "markdown")) {
    throw new Error("cssSelector cannot be used with markdown content");
  }
  return { format, cssSelector, tabId };
}

async function request(message: Record<string, unknown>): Promise<BrowserTab[] | string> {
  if (message.method === "getTabs") {
    const tabs = await api.tabs.query({ windowType: "normal" });
    return tabs.flatMap(tab => tab.id === undefined ? [] : [{
      id: tab.id,
      url: tab.url ?? "",
      active: tab.active,
      title: tab.title,
      favicon: tab.favIconUrl,
    }]);
  }
  if (message.method !== "getContent") throw new Error("Unknown browser method");
  const options = contentOptions(message.options);
  const tabId = options.tabId ?? (await api.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
  if (tabId === undefined) throw new Error("No active browser tab");
  const results = await api.scripting.executeScript({ target: { tabId }, func: extractContent, args: [options] });
  const result = results[0];
  if (result?.error) throw new Error(result.error.message || "Could not read browser content");
  return result?.result ?? "";
}

function extractContent({ format = "markdown", cssSelector }: BrowserContentOptions): string {
  if (cssSelector && format === "markdown") throw new Error("cssSelector cannot be used with markdown content");
  const root = cssSelector ? document.querySelector(cssSelector) : document.body;
  if (!root) return "";
  if (format === "html") return root.outerHTML;
  if (format === "text") return root instanceof HTMLElement ? root.innerText : root.textContent ?? "";
  if (format !== "markdown") throw new Error("Unknown content format");
  const article = document.querySelector("article, main, [role=main]") || root;
  const inline = new Set(["A", "STRONG", "B", "EM", "I", "DEL", "S", "CODE", "SPAN"]);
  const excluded = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "NAV", "BUTTON", "INPUT", "TEXTAREA", "SELECT"]);
  const escape = (text: string): string => text.replace(/[\\`*_[\]]/g, "\\$&");
  function markdown(node: Node, listDepth = 0): string {
    if (node.nodeType === Node.TEXT_NODE) return escape((node.textContent ?? "").replace(/\s+/g, " "));
    if (!(node instanceof Element) || excluded.has(node.tagName) || node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return "";
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return "";
    const tag = node.tagName;
    if (tag === "PRE") return `\n\n\`\`\`\n${(node instanceof HTMLElement ? node.innerText : node.textContent ?? "").trim()}\n\`\`\`\n\n`;
    if (tag === "IMG" && node instanceof HTMLImageElement) return node.src ? `![${escape(node.alt || "")}](${node.src})` : "";
    if (tag === "CODE") return `\`${(node.textContent ?? "").replaceAll("`", "\\`")}\``;
    if (tag === "BR") return "\n";
    if (tag === "HR") return "\n\n---\n\n";
    if (tag === "TR") return `\n| ${[...node.children].map(cell => markdown(cell).trim()).join(" | ")} |`;
    const childDepth = listDepth + (tag === "OL" || tag === "UL" ? 1 : 0);
    const content = [...node.childNodes].map(child => markdown(child, childDepth)).join("");
    if (/^H[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${content.trim()}\n\n`;
    if (tag === "A" && node instanceof HTMLAnchorElement) return node.href ? `[${content.trim()}](${node.href})` : content;
    if (tag === "STRONG" || tag === "B") return `**${content.trim()}**`;
    if (tag === "EM" || tag === "I") return `*${content.trim()}*`;
    if (tag === "DEL" || tag === "S") return `~~${content.trim()}~~`;
    if (tag === "LI") {
      const parent = node.parentElement;
      const prefix = parent?.tagName === "OL" ? `${[...parent.children].indexOf(node) + 1}.` : "-";
      return `\n${"  ".repeat(Math.max(0, listDepth - 1))}${prefix} ${content.trim()}`;
    }
    if (tag === "BLOCKQUOTE") return `\n\n${content.trim().split("\n").map(line => `> ${line}`).join("\n")}\n\n`;
    if (tag === "TD" || tag === "TH" || inline.has(tag)) return content;
    return `\n\n${content.trim()}\n\n`;
  }
  return markdown(article).replace(/\n[ \t]+\n/g, "\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

api.windows.onFocusChanged.addListener(id => {
  const port = nativePort;
  if (id !== api.windows.WINDOW_ID_NONE && port) postMessage(port, { type: "focused" });
});
api.runtime.onInstalled.addListener(connect);
api.runtime.onStartup.addListener(connect);
api.runtime.onMessage.addListener((message, _sender, respond) => {
  if (isRecord(message) && message.type === "status") { connect(); respond({ connected }); }
});
connect();
