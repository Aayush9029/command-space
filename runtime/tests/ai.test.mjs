import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AI, aiAvailable } from "../ai.mjs";

test("AI streams split SSE frames, maps models, and forwards cancellation", async t => {
  let request;
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    request = {path:req.url, body:JSON.parse(body), authorization:req.headers.authorization};
    res.writeHead(200, {"Content-Type":"text/event-stream"});
    if (request.body.messages[0].content === "cancel") { res.write(": pending\n\n"); return; }
    res.write('data: {"choices":[{"delta":{"content":"Hello ');
    setTimeout(() => res.end('world"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"!"}}]}\n\ndata: [DONE]\n\n'), 10);
  });
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(() => { server.closeAllConnections(); server.close(); delete globalThis.__superSpace; delete process.env.SUPER_SPACE_AI_API_KEY; });
  globalThis.__superSpace = {ai:{endpoint:`http://127.0.0.1:${server.address().port}/v1`,model:"local-model",models:{preferred:"mapped-model"}}};
  process.env.SUPER_SPACE_AI_API_KEY = "synthetic-test-key";
  assert.ok(aiAvailable());
  const chunks = [];
  const answer = AI.ask("hello",{model:"preferred",creativity:3}).on("data",chunk => chunks.push(chunk));
  assert.equal(await answer,"Hello world!");
  assert.deepEqual(chunks,["Hello world","!"]);
  assert.equal(request.path,"/v1/chat/completions");
  assert.equal(request.body.model,"mapped-model");
  assert.equal(request.body.temperature,2);
  assert.equal(request.authorization,"Bearer synthetic-test-key");
  const controller = new AbortController();
  const canceled = AI.ask("cancel",{signal:controller.signal});
  setTimeout(() => controller.abort(),20);
  await assert.rejects(canceled,error => error.name === "AbortError");
});
