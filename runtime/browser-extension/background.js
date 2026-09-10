const api = globalThis.browser || chrome;
let nativePort, retryTimer, retries = 0, connected = false;

function connect() {
  if (nativePort) return;
  clearTimeout(retryTimer);
  const port = api.runtime.connectNative("com.superspace.bridge");
  nativePort = port;
  port.onMessage.addListener(async message => {
    if (message.type === "ready") { retries = 0; connected = true; await badge(""); return; }
    try { port.postMessage({id:message.id, result:await request(message)}); }
    catch (error) { port.postMessage({id:message.id, error:error.message}); }
  });
  port.onDisconnect.addListener(() => {
    void api.runtime.lastError;
    if (nativePort !== port) return;
    nativePort = undefined;
    connected = false;
    void badge("!");
    retryTimer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retries++));
  });
}
async function badge(text) {
  await api.action.setBadgeText({text});
  await api.action.setBadgeBackgroundColor({color:"#7aa2f7"});
}
async function request({method, options = {}}) {
  if (method === "getTabs") {
    const tabs = await api.tabs.query({windowType:"normal"});
    return tabs.map(tab => ({id:tab.id, url:tab.url || "", active:tab.active, title:tab.title, favicon:tab.favIconUrl}));
  }
  if (method !== "getContent") throw new Error("Unknown browser method");
  const tabId = options.tabId ?? (await api.tabs.query({active:true, lastFocusedWindow:true}))[0]?.id;
  if (tabId === undefined) throw new Error("No active browser tab");
  const result = await api.scripting.executeScript({target:{tabId}, func:extractContent, args:[options]});
  return result[0]?.result || "";
}

function extractContent({format = "markdown", cssSelector}) {
  if (cssSelector && format === "markdown") throw new Error("cssSelector cannot be used with markdown content");
  const root = cssSelector ? document.querySelector(cssSelector) : document.body;
  if (!root) return "";
  if (format === "html") return root.outerHTML;
  if (format === "text") return root.innerText;
  if (format !== "markdown") throw new Error("Unknown content format");
  const article = document.querySelector("article, main, [role=main]") || root;
  const inline = new Set(["A", "STRONG", "B", "EM", "I", "DEL", "S", "CODE", "SPAN"]);
  const escape = text => text.replace(/[\\`*_[\]]/g, "\\$&");
  function markdown(node, listDepth = 0) {
    if (node.nodeType === Node.TEXT_NODE) return escape(node.textContent.replace(/\s+/g, " "));
    if (node.nodeType !== Node.ELEMENT_NODE || ["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "NAV", "BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(node.tagName) || node.hidden || node.getAttribute("aria-hidden") === "true") return "";
    if (getComputedStyle(node).display === "none" || getComputedStyle(node).visibility === "hidden") return "";
    const tag = node.tagName;
    if (tag === "PRE") return `\n\n\`\`\`\n${node.innerText.trim()}\n\`\`\`\n\n`;
    const content = [...node.childNodes].map(child => markdown(child, listDepth + (["OL", "UL"].includes(tag) ? 1 : 0))).join("");
    if (/^H[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${content.trim()}\n\n`;
    if (tag === "A") return node.href ? `[${content.trim()}](${node.href})` : content;
    if (tag === "IMG") return node.src ? `![${escape(node.alt || "")}](${node.src})` : "";
    if (tag === "STRONG" || tag === "B") return `**${content.trim()}**`;
    if (tag === "EM" || tag === "I") return `*${content.trim()}*`;
    if (tag === "DEL" || tag === "S") return `~~${content.trim()}~~`;
    if (tag === "CODE") return `\`${node.textContent.replaceAll("`", "\\`")}\``;
    if (tag === "BR") return "\n";
    if (tag === "HR") return "\n\n---\n\n";
    if (tag === "LI") {
      const prefix = node.parentElement.tagName === "OL" ? `${[...node.parentElement.children].indexOf(node) + 1}.` : "-";
      return `\n${"  ".repeat(Math.max(0, listDepth - 1))}${prefix} ${content.trim()}`;
    }
    if (tag === "BLOCKQUOTE") return `\n\n${content.trim().split("\n").map(line => `> ${line}`).join("\n")}\n\n`;
    if (tag === "TR") return `\n| ${[...node.children].map(cell => markdown(cell).trim()).join(" | ")} |`;
    if (tag === "TD" || tag === "TH" || inline.has(tag)) return content;
    return `\n\n${content.trim()}\n\n`;
  }
  return markdown(article).replace(/\n[ \t]+\n/g, "\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

api.windows.onFocusChanged.addListener(id => { if (id !== api.windows.WINDOW_ID_NONE) nativePort?.postMessage({type:"focused"}); });
api.runtime.onInstalled.addListener(connect);
api.runtime.onStartup.addListener(connect);
api.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === "status") { connect(); respond({connected}); }
});
connect();
