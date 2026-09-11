import { EventEmitter } from "node:events";
import { lookupCredential } from "./oauth.ts";
import { isRecord } from "./types.ts";

const creativityLevels = { none: 0, low: 0.3, medium: 0.7, high: 1, maximum: 2 };
export interface AIAskOptions {
  model?: string;
  creativity?: number | keyof typeof creativityLevels;
  signal?: AbortSignal;
}
type AIEvents = { data: [chunk: string]; end: []; error: [error: unknown] };
type AIListener<K extends keyof AIEvents> = K extends keyof AIEvents ? AIEvents[K] extends unknown[] ? (...args: AIEvents[K]) => void : never : never;
export interface AIResponse extends Promise<string> {
  on<K extends keyof AIEvents>(event: K, listener: AIListener<K>): AIResponse;
  once<K extends keyof AIEvents>(event: K, listener: AIListener<K>): AIResponse;
  off<K extends keyof AIEvents>(event: K, listener: AIListener<K>): AIResponse;
  addListener<K extends keyof AIEvents>(event: K, listener: AIListener<K>): AIResponse;
  removeListener<K extends keyof AIEvents>(event: K, listener: AIListener<K>): AIResponse;
  removeAllListeners(event?: keyof AIEvents): AIResponse;
}

export function aiAvailable(): boolean {
  const config = globalThis.__superSpace?.ai;
  return Boolean(config?.endpoint && config?.model);
}

function providerMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const error = isRecord(value.error) ? value.error : value;
  return typeof error.message === "string" ? error.message : undefined;
}

function responseContent(value: unknown, streaming: boolean): string {
  if (!isRecord(value)) throw new Error("AI provider returned an invalid response");
  if (value.error) throw new Error(providerMessage(value) || "AI provider stream failed");
  if (!Array.isArray(value.choices)) throw new Error("AI provider response is missing choices");
  if (!value.choices.length) return "";
  const choice: unknown = value.choices[0];
  if (!isRecord(choice)) throw new Error("AI provider returned an invalid choice");
  const message = choice[streaming ? "delta" : "message"];
  if (!isRecord(message)) throw new Error("AI provider returned an invalid message");
  const content = message.content;
  if (content === undefined || content === null) return "";
  if (typeof content !== "string") throw new Error("AI provider returned non-text content");
  return content;
}

export const AI = {
  __superSpaceCapability: "ai",
  Model: new Proxy<Record<string, string>>({}, { get: (_, name) => String(name) }),
  ask(prompt: string, options: AIAskOptions = {}): AIResponse {
    const events = new EventEmitter<AIEvents>();
    const answer = Promise.resolve().then(async () => {
      const config = globalThis.__superSpace?.ai;
      if (!config?.endpoint || !config.model) throw new Error("Choose an AI endpoint and model in Super Space Settings → Extensions");
      const endpoint = new URL(config.endpoint.endsWith("/") ? config.endpoint : `${config.endpoint}/`);
      if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("The AI endpoint must use HTTP or HTTPS");
      const token = process.env.SUPER_SPACE_AI_API_KEY || await lookupCredential(["service", "ai", "endpoint", config.endpoint], "Super Space AI provider");
      const creativity = typeof options.creativity === "number" ? options.creativity : options.creativity ? creativityLevels[options.creativity] : undefined;
      if (creativity !== undefined && !Number.isFinite(creativity)) throw new Error("AI creativity must be a finite number");
      const body = {
        model: (options.model && config.models?.[options.model]) || config.model,
        messages: [{ role: "user", content: String(prompt) }],
        stream: true,
        ...(creativity !== undefined ? { temperature: Math.min(2, Math.max(0, creativity)) } : {}),
      };
      const response = await fetch(new URL("chat/completions", endpoint), {
        method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body), signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
      });
      if (!response.ok) {
        let message: string | undefined;
        try { message = providerMessage(await response.json()); } catch {}
        throw new Error(message || `AI provider returned HTTP ${response.status}`);
      }
      let result = "";
      const append = (text: string) => { if (text) { result += text; events.emit("data", text); } };
      if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        append(responseContent(await response.json(), false));
      } else {
        if (!response.body) throw new Error("AI provider returned an empty stream");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let data: string[] = [];
        let completed = false;
        const dispatch = () => {
          const payload = data.join("\n"); data = [];
          if (payload === "[DONE]") { completed = true; return; }
          if (payload) append(responseContent(JSON.parse(payload), true));
        };
        try {
          while (!completed) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            let index: number;
            while (!completed && (index = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, index).replace(/\r$/, ""); buffer = buffer.slice(index + 1);
              if (!line) dispatch();
              else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
            }
            if (done) {
              if (!completed) {
                if (buffer.startsWith("data:")) data.push(buffer.slice(5).trimStart());
                dispatch();
              }
              break;
            }
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
      events.emit("end");
      return result;
    });
    answer.catch(error => { if (events.listenerCount("error")) events.emit("error", error); });
    const stream: AIResponse = Object.assign(answer, {
      on<K extends keyof AIEvents>(event: K, listener: AIListener<K>) { events.on(event, listener); return stream; },
      once<K extends keyof AIEvents>(event: K, listener: AIListener<K>) { events.once(event, listener); return stream; },
      off<K extends keyof AIEvents>(event: K, listener: AIListener<K>) { events.off(event, listener); return stream; },
      addListener<K extends keyof AIEvents>(event: K, listener: AIListener<K>) { events.addListener(event, listener); return stream; },
      removeListener<K extends keyof AIEvents>(event: K, listener: AIListener<K>) { events.removeListener(event, listener); return stream; },
      removeAllListeners(event?: keyof AIEvents) { events.removeAllListeners(event); return stream; },
    });
    return stream;
  },
};
export namespace AI {
  export type Model = string;
  export type Creativity = AIAskOptions["creativity"];
  export type AskOptions = AIAskOptions;
  export type AskResponse = AIResponse;
}
