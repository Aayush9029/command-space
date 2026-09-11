import type { BrowserContentOptions, BrowserTab } from "../browser.ts";

export type { BrowserContentOptions, BrowserTab };

export interface BrowserEvent<Listener extends (...args: never[]) => unknown> {
  addListener(listener: Listener): void;
}

export interface NativePort {
  onMessage: BrowserEvent<(message: unknown) => void>;
  onDisconnect: BrowserEvent<() => void>;
  postMessage(message: unknown): void;
  disconnect(): void;
}

interface Tab {
  id?: number;
  url?: string;
  active: boolean;
  title?: string;
  favIconUrl?: string;
}

export interface BrowserAPI {
  runtime: {
    connectNative(name: string): NativePort;
    lastError?: { message?: string };
    onInstalled: BrowserEvent<() => void>;
    onStartup: BrowserEvent<() => void>;
    onMessage: BrowserEvent<(message: unknown, sender: unknown, respond: (response: unknown) => void) => void>;
    sendMessage(message: unknown): Promise<unknown>;
  };
  action: {
    setBadgeText(details: { text: string }): Promise<void>;
    setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  };
  tabs: {
    query(query: { windowType?: "normal"; active?: boolean; lastFocusedWindow?: boolean }): Promise<Tab[]>;
  };
  scripting: {
    executeScript(details: {
      target: { tabId: number };
      func: (options: BrowserContentOptions) => string;
      args: [BrowserContentOptions];
    }): Promise<{ result?: string; error?: { message?: string } }[]>;
  };
  windows: {
    WINDOW_ID_NONE: number;
    onFocusChanged: BrowserEvent<(id: number) => void>;
  };
}

export interface BrowserGlobals {
  browser?: BrowserAPI;
  chrome?: BrowserAPI;
}
