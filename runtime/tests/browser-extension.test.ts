import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "bun:test";
import type { BrowserAPI, NativePort } from "../browser-extension/types.ts";

const transpiler = new Bun.Transpiler({ loader: "ts" });
const background = transpiler.transformSync(readFileSync(new URL("../browser-extension/background.ts", import.meta.url), "utf8"));
const popup = transpiler.transformSync(readFileSync(new URL("../browser-extension/popup.ts", import.meta.url), "utf8"));

function event<Args extends unknown[]>() {
  const listeners: ((...args: Args) => void)[] = [];
  return {
    addListener(listener: (...args: Args) => void) { listeners.push(listener); },
    emit(...args: Args) { for (const listener of listeners) listener(...args); },
  };
}

function nativePort() {
  const messages: unknown[] = [];
  let failPosting = false;
  const onMessage = event<[unknown]>();
  const onDisconnect = event<[]>();
  return {
    messages,
    onMessage,
    onDisconnect,
    failPosting() { failPosting = true; },
    postMessage(message: unknown) {
      if (failPosting) throw new Error("Port disconnected");
      messages.push(structuredClone(message));
    },
    disconnect() { onDisconnect.emit(); },
  } satisfies NativePort & { messages: unknown[]; failPosting(): void };
}

function harness(failConnections = 0) {
  const ports: ReturnType<typeof nativePort>[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const badges: string[] = [];
  const focus = event<[number]>();
  const messages = event<[unknown, unknown, (response: unknown) => void]>();
  let timerSequence = 0;
  let query: BrowserAPI["tabs"]["query"] = async () => [];
  let execute: BrowserAPI["scripting"]["executeScript"] = async () => [];
  const api: BrowserAPI = {
    runtime: {
      connectNative(name) {
        assert.equal(name, "com.superspace.bridge");
        if (failConnections-- > 0) throw new Error("Native host is unavailable");
        const port = nativePort();
        ports.push(port);
        return port;
      },
      onInstalled: event<[]>(),
      onStartup: event<[]>(),
      onMessage: messages,
      sendMessage: async () => undefined,
    },
    action: {
      setBadgeText: async ({ text }) => { badges.push(text); },
      setBadgeBackgroundColor: async () => {},
    },
    tabs: { query: options => query(options) },
    scripting: { executeScript: options => execute(options) },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: focus },
  };
  runInNewContext(background, {
    browser: api,
    setTimeout(callback: () => void, delay: number) {
      timers.set(++timerSequence, { callback, delay });
      return timerSequence;
    },
    clearTimeout(id: number) { timers.delete(id); },
  });
  return {
    ports,
    timers,
    badges,
    focus,
    api,
    query(value: BrowserAPI["tabs"]["query"]) { query = value; },
    execute(value: BrowserAPI["scripting"]["executeScript"]) { execute = value; },
    status() {
      let response: unknown;
      messages.emit({ type: "status" }, {}, value => { response = structuredClone(value); });
      return response;
    },
    retry() {
      const next = timers.entries().next().value;
      assert.ok(next);
      timers.delete(next[0]);
      next[1].callback();
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index++) await Promise.resolve();
}

test("browser extension validates native requests and returns usable tab records", async () => {
  const app = harness();
  const port = app.ports[0];
  assert.ok(port);
  app.query(async options => {
    assert.deepEqual(structuredClone(options), { windowType: "normal" });
    return [{ id: 7, active: true, url: "https://example.com", title: "Example" }, { active: false }];
  });
  port.onMessage.emit(null);
  port.onMessage.emit({ method: "getTabs" });
  port.onMessage.emit({ id: "1", method: "getTabs" });
  port.onMessage.emit({ id: "2", method: "getContent", options: { tabId: "7" } });
  port.onMessage.emit({ id: "3", method: "getContent", options: { format: "markdown", cssSelector: "main" } });
  port.onMessage.emit({ id: "4", method: "getContent", options: [] });
  port.onMessage.emit({ id: "5", method: "unsupported" });
  await settle();
  assert.equal(port.messages.length, 5);
  assert.ok(port.messages.some(message => JSON.stringify(message) === JSON.stringify({
    id: "1", result: [{ id: 7, url: "https://example.com", active: true, title: "Example" }],
  })));
  const errors = port.messages.filter((value): value is { id: string; error: string } => (
    typeof value === "object" && value !== null && "error" in value && typeof value.error === "string"
  ));
  assert.equal(errors.length, 4);
  assert.ok(errors.some(({ id, error }) => id === "2" && error.includes("tabId")));
  assert.ok(errors.some(({ id, error }) => id === "3" && error.includes("cssSelector")));
  assert.ok(errors.some(({ id, error }) => id === "4" && error.includes("object")));
  assert.ok(errors.some(({ id, error }) => id === "5" && error.includes("Unknown browser method")));
});

test("browser extraction targets the selected tab and reports injection failures", async () => {
  const app = harness();
  const port = app.ports[0];
  assert.ok(port);
  app.query(async () => [{ id: 12, active: true }]);
  app.execute(async options => {
    assert.equal(options.target.tabId, 12);
    assert.deepEqual(structuredClone(options.args), [{ format: "text", cssSelector: ".article", tabId: undefined }]);
    assert.equal(typeof options.func, "function");
    return [{ result: "Selected article" }];
  });
  port.onMessage.emit({ id: "1", method: "getContent", options: { format: "text", cssSelector: ".article" } });
  await settle();
  assert.deepEqual(port.messages, [{ id: "1", result: "Selected article" }]);
  app.execute(async () => [{ error: { message: "Page access denied" } }]);
  port.onMessage.emit({ id: "2", method: "getContent", options: { tabId: 99 } });
  await settle();
  assert.deepEqual(port.messages[1], { id: "2", error: "Page access denied" });
});

test("browser reconnects after failed connections with bounded backoff", () => {
  const app = harness(8);
  assert.equal(app.timers.size, 1);
  const delays: number[] = [];
  while (!app.ports.length) {
    const timer = app.timers.values().next().value;
    assert.ok(timer);
    delays.push(timer.delay);
    app.retry();
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  const port = app.ports[0];
  assert.ok(port);
  port.onMessage.emit({ type: "ready" });
  assert.deepEqual(app.status(), { connected: true });
  port.disconnect();
  assert.equal(app.timers.values().next().value?.delay, 1000);
});

test("browser drops stale responses and ignores stale disconnect events", async () => {
  const app = harness();
  const first = app.ports[0];
  assert.ok(first);
  let finish: ((value: { result: string }[]) => void) | undefined;
  app.execute(() => new Promise(resolve => { finish = resolve; }));
  first.onMessage.emit({ id: "1", method: "getContent", options: { tabId: 3 } });
  await settle();
  first.disconnect();
  app.retry();
  const second = app.ports[1];
  assert.ok(second);
  second.onMessage.emit({ type: "ready" });
  first.disconnect();
  finish?.([{ result: "Old content" }]);
  await settle();
  assert.deepEqual(first.messages, []);
  assert.equal(app.timers.size, 0);
  assert.deepEqual(app.status(), { connected: true });
  app.focus.emit(-1);
  assert.deepEqual(second.messages, []);
  app.focus.emit(4);
  assert.deepEqual(second.messages, [{ type: "focused" }]);
  second.failPosting();
  assert.doesNotThrow(() => app.focus.emit(4));
  assert.equal(app.timers.size, 1);
});

test("browser popup handles missing status elements and rejected status requests", async () => {
  assert.doesNotThrow(() => runInNewContext(popup, { document: { querySelector: () => null } }));
  const status = { textContent: "Connecting…" };
  runInNewContext(popup, {
    document: { querySelector: () => status },
    chrome: { runtime: { sendMessage: async () => { throw new Error("Background unavailable"); } } },
  });
  await settle();
  assert.equal(status.textContent, "Could not connect. Reopen this popup to try again.");
});

test("serialized page extraction preserves table content and visits each element once", async () => {
  const app = harness();
  const port = app.ports[0];
  assert.ok(port);
  let extract: ((options: object) => string) | undefined;
  app.execute(async ({ func }) => { extract = func; return []; });
  port.onMessage.emit({ id: "1", method: "getContent", options: { tabId: 1 } });
  await settle();
  assert.ok(extract);

  class TextNode {
    static TEXT_NODE = 3;
    readonly nodeType = 3;
    constructor(readonly textContent: string) {}
  }
  class ElementNode {
    readonly nodeType = 1;
    parentElement: ElementNode | null = null;
    constructor(readonly tagName: string, readonly childNodes: (ElementNode | TextNode)[] = []) {
      for (const child of childNodes) if (child instanceof ElementNode) child.parentElement = this;
    }
    get children(): ElementNode[] { return this.childNodes.filter((child): child is ElementNode => child instanceof ElementNode); }
    get textContent(): string { return this.childNodes.map(child => child.textContent).join(""); }
    get innerText(): string { return this.textContent; }
    hasAttribute(): boolean { return false; }
    getAttribute(): null { return null; }
  }
  const table = new ElementNode("TABLE", [new ElementNode("TR", [
    new ElementNode("TD", [new TextNode("Alpha * literal")]),
    new ElementNode("TD", [new ElementNode("STRONG", [new TextNode("Beta")])]),
  ])]);
  const article = new ElementNode("ARTICLE", [table]);
  const visits = new Map<ElementNode, number>();
  const result: unknown = runInNewContext(`(${extract.toString()})({})`, {
    Node: TextNode,
    Element: ElementNode,
    HTMLElement: ElementNode,
    HTMLAnchorElement: class {},
    HTMLImageElement: class {},
    document: { body: article, querySelector: () => article },
    getComputedStyle(node: ElementNode) {
      visits.set(node, (visits.get(node) ?? 0) + 1);
      return { display: "block", visibility: "visible" };
    },
  });
  assert.equal(result, "| Alpha \\* literal | **Beta** |");
  assert.equal(visits.size, 6);
  assert.ok([...visits.values()].every(count => count === 1));
});
