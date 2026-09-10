import { EventEmitter } from "node:events";
import { lookupCredential } from "./oauth.mjs";

export function aiAvailable() {
  const config = globalThis.__superSpace?.ai;
  return Boolean(config?.endpoint && config?.model);
}

export const AI = {
  __superSpaceCapability: "ai",
  Model: new Proxy({}, {get: (_, name) => String(name)}),
  ask(prompt, options = {}) {
    const events = new EventEmitter();
    const answer = Promise.resolve().then(async () => {
      const config = globalThis.__superSpace?.ai;
      if (!aiAvailable()) throw new Error("Choose an AI endpoint and model in Super Space Settings → Extensions");
      const endpoint = new URL(config.endpoint.endsWith("/") ? config.endpoint : `${config.endpoint}/`);
      if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("The AI endpoint must use HTTP or HTTPS");
      const token = process.env.SUPER_SPACE_AI_API_KEY || await lookupCredential(["service", "ai", "endpoint", config.endpoint], "Super Space AI provider");
      const creativity = typeof options.creativity === "number" ? options.creativity : {none:0,low:0.3,medium:0.7,high:1,maximum:2}[options.creativity];
      const body = {model:config.models?.[options.model] || config.model, messages:[{role:"user", content:String(prompt)}], stream:true};
      if (creativity !== undefined) body.temperature = Math.min(2, Math.max(0, creativity));
      const response = await fetch(new URL("chat/completions", endpoint), {
        method:"POST", headers:{"Content-Type":"application/json", ...(token ? {Authorization:`Bearer ${token}`} : {})},
        body:JSON.stringify(body), signal:options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
      });
      if (!response.ok) {
        let message; try { const data = await response.json(); message = data.error?.message || data.message; } catch {}
        throw new Error(message || `AI provider returned HTTP ${response.status}`);
      }
      let result = "";
      const append = text => { if (text) { result += text; events.emit("data", text); } };
      if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        const data = await response.json(); append(data.choices?.[0]?.message?.content || "");
      } else {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "", data = [];
        const dispatch = () => {
          const payload = data.join("\n"); data = [];
          if (!payload || payload === "[DONE]") return;
          const chunk = JSON.parse(payload);
          if (chunk.error) throw new Error(chunk.error.message || "AI provider stream failed");
          append(chunk.choices?.[0]?.delta?.content || "");
        };
        try {
          while (true) {
            const {value, done} = await reader.read();
            buffer += decoder.decode(value, {stream:!done});
            let index;
            while ((index = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0,index).replace(/\r$/, ""); buffer = buffer.slice(index + 1);
              if (!line) dispatch();
              else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
            }
            if (done) { if (buffer.startsWith("data:")) data.push(buffer.slice(5).trimStart()); dispatch(); break; }
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
      events.emit("end");
      return result;
    });
    answer.catch(error => { if (events.listenerCount("error")) events.emit("error", error); });
    for (const name of ["on", "once", "off", "addListener", "removeListener", "removeAllListeners"]) answer[name] = (...args) => { events[name](...args); return answer; };
    return answer;
  },
};
