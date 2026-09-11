import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AI, aiAvailable } from "../ai.ts";
import { isRecord, type ValueRecord } from "../types.ts";

async function provider(t: TestContext, handler: http.RequestListener): Promise<void> {
  const previousContext = globalThis.__superSpace;
  const previousKey = process.env.SUPER_SPACE_AI_API_KEY;
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections(); server.close();
    globalThis.__superSpace = previousContext;
    if (previousKey === undefined) delete process.env.SUPER_SPACE_AI_API_KEY;
    else process.env.SUPER_SPACE_AI_API_KEY = previousKey;
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  globalThis.__superSpace = { ai: { endpoint: `http://127.0.0.1:${address.port}/v1`, model: "local-model", models: { preferred: "mapped-model" } } };
  process.env.SUPER_SPACE_AI_API_KEY = "synthetic-test-key";
}

test("AI streams split SSE frames, maps models, and forwards cancellation", async t => {
  let request: { path?: string; body: ValueRecord; authorization?: string } | undefined;
  await provider(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body: unknown = JSON.parse(text);
    assert.ok(isRecord(body));
    request = { path: req.url, body, authorization: req.headers.authorization };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const message: unknown = Array.isArray(body.messages) ? body.messages[0] : undefined;
    if (isRecord(message) && message.content === "cancel") { res.write(": pending\n\n"); return; }
    res.write('data: {"choices":[{"delta":{"content":"Hello ');
    setTimeout(() => res.end('world"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"!"}}]}\n\ndata: [DONE]\n\n'), 10);
  });
  assert.ok(aiAvailable());
  const chunks: string[] = [];
  const answer = AI.ask("hello", { model: "preferred", creativity: 3 }).on("data", chunk => chunks.push(chunk));
  assert.equal(await answer, "Hello world!");
  assert.deepEqual(chunks, ["Hello world", "!"]);
  assert.ok(request);
  assert.equal(request.path, "/v1/chat/completions");
  assert.equal(request.body.model, "mapped-model");
  assert.equal(request.body.temperature, 2);
  assert.equal(request.authorization, "Bearer synthetic-test-key");
  const controller = new AbortController();
  const canceled = AI.ask("cancel", { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(canceled, (error: unknown) => error instanceof Error && error.name === "AbortError");
});

test("AI completes on the SSE done marker without waiting for the provider to close", { timeout: 5000 }, async t => {
  await provider(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"Finished"}}]}\n\ndata: [DONE]\n\n');
  });
  let ended = 0;
  const ignored = () => assert.fail("Removed data listener was invoked");
  const answer = AI.ask("finish").once("end", () => ended++).on("data", ignored).off("data", ignored);
  assert.equal(await answer, "Finished");
  assert.equal(ended, 1);
});

test("AI accepts JSON responses and reports malformed stream content through errors", async t => {
  let call = 0;
  await provider(t, (_req, res) => {
    if (call++ === 0) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "Plain response" } }] }));
    } else {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":{"unexpected":true}}}]}\n\n');
    }
  });
  assert.equal(await AI.ask("json"), "Plain response");
  let emitted: unknown;
  const invalid = AI.ask("invalid").on("error", error => { emitted = error; });
  await assert.rejects(invalid, /non-text content/);
  assert.ok(emitted instanceof Error);
  assert.match(emitted.message, /non-text content/);
});

test("AI propagates provider errors and rejects non-finite creativity before requesting", async t => {
  let requests = 0;
  await provider(t, (_req, res) => {
    requests++;
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Provider rate limit" } }));
  });
  await assert.rejects(AI.ask("too creative", { creativity: Number.NaN }), /finite number/);
  assert.equal(requests, 0);
  await assert.rejects(AI.ask("limited"), /Provider rate limit/);
  assert.equal(requests, 1);
});
