import type { BrowserGlobals } from "./types.ts";

const browserGlobals = globalThis as typeof globalThis & BrowserGlobals;
const api = browserGlobals.browser ?? browserGlobals.chrome;
const status = document.querySelector("#status");
if (status) {
  void (async () => {
    try {
      const result = await api?.runtime.sendMessage({ type: "status" });
      status.textContent = typeof result === "object" && result !== null && "connected" in result && result.connected === true
        ? "Connected to your desktop"
        : "Install Super Space on this computer to connect";
    } catch {
      status.textContent = "Could not connect. Reopen this popup to try again.";
    }
  })();
}
