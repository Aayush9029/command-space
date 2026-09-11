import { createFrameQueue, type FrameQueue } from "./vm-viewer-frame-queue.ts";

type Input =
  | { type: "click"; x: number; y: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string }
  | { type: "chord"; keys: string[] }
  | { type: "wheel"; direction: "wheel-down" | "wheel-up" }
  | { type: "key-state"; key: string; down: boolean };

interface Frame {
  image: HTMLImageElement;
  url: string;
}

declare global {
  interface Window {
    superSpaceViewer: FrameQueue<Input>;
    post: FrameQueue<Input>["post"];
    refresh: FrameQueue<Input>["refresh"];
    readonly queue: FrameQueue<Input>["queue"];
  }
}

function element<T extends Element>(selector: string, type: { new(...args: never[]): T }): T {
  const value = document.querySelector(selector);
  if (!(value instanceof type)) throw new Error(`Missing viewer element: ${selector}`);
  return value;
}

const token = new URLSearchParams(location.search).get("token");
if (!token) throw new Error("The viewer URL must include its access token");
const screen = element("#screen", HTMLCanvasElement);
const status = element("#status", HTMLElement);
const typing = element("#typing", HTMLInputElement);
const send = element("#send", HTMLButtonElement);
const context = screen.getContext("2d");
if (!context) throw new Error("The viewer requires a canvas drawing context");
const drawingContext: CanvasRenderingContext2D = context;
const showError = (error: unknown) => { status.textContent = error instanceof Error ? error.message : String(error); };
const frames = createFrameQueue<Input, Frame>({
  async send(value) {
    const response = await fetch(`/input?token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    if (!response.ok) throw new Error(`Input failed: ${response.status}`);
  },
  async capture(sequence) {
    const response = await fetch(`/frame?token=${token}&sequence=${sequence}&t=${Date.now()}`);
    if (!response.ok) throw new Error("Frame delayed");
    const url = URL.createObjectURL(await response.blob());
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return { image, url };
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  },
  display({ image }) {
    screen.width = image.naturalWidth;
    screen.height = image.naturalHeight;
    drawingContext.drawImage(image, 0, 0);
    status.textContent = "Live";
  },
  discard: ({ url }) => URL.revokeObjectURL(url),
  onError: showError,
});

window.superSpaceViewer = frames;
window.post = frames.post;
window.refresh = frames.refresh;
Object.defineProperty(window, "queue", { configurable: true, get: () => frames.queue });

element("#refresh", HTMLButtonElement).onclick = () => { frames.refresh().catch(showError); };
screen.onclick = event => {
  const rect = screen.getBoundingClientRect();
  frames.post({ type: "click", x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height });
  screen.focus();
};
send.onclick = () => {
  frames.post({ type: "text", text: typing.value });
  typing.value = "";
};
typing.onkeydown = event => {
  if (event.key === "Enter") {
    event.preventDefault();
    send.click();
  }
};
for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-key]")) {
  const key = button.dataset.key;
  if (key) button.onclick = () => { frames.post({ type: "key", key }); };
}
for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-chord]")) {
  const chord = button.dataset.chord;
  if (chord) button.onclick = () => { frames.post({ type: "chord", keys: chord.split(",") }); };
}
screen.onwheel = event => {
  event.preventDefault();
  frames.post({ type: "wheel", direction: event.deltaY > 0 ? "wheel-down" : "wheel-up" });
};
const keys: Record<string, string> = {
  Enter: "ret", Escape: "esc", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Backspace: "backspace", Tab: "tab", Space: "spc",
  ControlLeft: "ctrl", ControlRight: "ctrl_r", MetaLeft: "meta_l", MetaRight: "meta_r", AltLeft: "alt", AltRight: "alt_r", ShiftLeft: "shift", ShiftRight: "shift_r",
};
function keyState(event: KeyboardEvent, down: boolean) {
  event.preventDefault();
  const key = keys[event.code] || (event.code.startsWith("Key") ? event.code.slice(3).toLowerCase() : event.code.startsWith("Digit") ? event.code.slice(5) : undefined);
  if (key) frames.post({ type: "key-state", key, down });
}
screen.onkeydown = event => keyState(event, true);
screen.onkeyup = event => keyState(event, false);
frames.refresh().catch(showError);
