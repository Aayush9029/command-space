import assert from "node:assert/strict";
import test from "node:test";
import {createFrameQueue} from "./vm-viewer-frame-queue.ts";

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return {promise, resolve, reject};
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await pause(2);
  }
  throw new Error("Frame queue did not reach the expected state");
}

test("refresh waits for a frame captured after completed input", async () => {
  const captures: ({sequence: number; input: number} & ReturnType<typeof deferred<string>>)[] = [];
  const shown: string[] = [];
  const discarded: string[] = [];
  const frames = createFrameQueue<{type: string; key: string}, string>({
    settleMs: 0,
    send: async () => {},
    capture: (sequence, input) => {
      const frame = deferred<string>();
      captures.push({sequence, input, ...frame});
      return frame.promise;
    },
    display: frame => { shown.push(frame); },
    discard: frame => { discarded.push(frame); },
  });
  const first = frames.refresh();
  await until(() => captures.length === 1);
  await frames.post({type: "key", key: "ret"});
  await frames.queue;
  let complete = false;
  const second = frames.refresh().then(result => { complete = true; return result; });
  captures[0].resolve("old frame");
  await until(() => captures.length === 2);
  assert.equal(complete, false);
  assert.deepEqual(shown, []);
  assert.equal(captures[1].input, 1);
  captures[1].resolve("fresh frame");
  const result = await second;
  await first;
  assert.deepEqual(result, {frameSequence: 2, inputSequence: 1});
  assert.deepEqual(shown, ["fresh frame"]);
  assert.deepEqual(discarded, ["old frame", "fresh frame"]);
});

test("a queued input batch produces one settled automatic frame", async () => {
  const sent: string[] = [];
  const captures: {sequence: number; input: number; sent: string[]}[] = [];
  const frames = createFrameQueue<string, number>({
    settleMs: 10,
    send: async value => { await pause(3); sent.push(value); },
    capture: (sequence, input) => { captures.push({sequence, input, sent: [...sent]}); return input; },
    display: () => {},
  });
  await Promise.all([frames.post("first"), frames.post("second"), frames.post("third")]);
  await frames.queue;
  await until(() => captures.length === 1);
  await pause(25);
  assert.equal(captures.length, 1);
  assert.deepEqual(captures[0].sent, ["first", "second", "third"]);
  assert.equal(captures[0].input, 3);
});

test("manual refresh consumes pending automatic work and concurrent requests", async () => {
  const captures: number[] = [];
  const frames = createFrameQueue<string, number>({
    settleMs: 10,
    send: async () => {},
    capture: sequence => { captures.push(sequence); return sequence; },
    display: () => {},
  });
  await frames.post("input");
  const results = await Promise.all([frames.refresh(), frames.refresh()]);
  await pause(25);
  assert.deepEqual(captures, [2]);
  assert.deepEqual(results, [{frameSequence: 2, inputSequence: 1}, {frameSequence: 2, inputSequence: 1}]);
});

test("capture failures reject refresh and allow a later retry", async () => {
  let attempts = 0;
  const frames = createFrameQueue<string, string>({
    settleMs: 0,
    send: async () => {},
    capture: () => { if (++attempts === 1) throw new Error("Unavailable"); return "recovered"; },
    display: () => {},
  });
  await assert.rejects(frames.refresh(), /Unavailable/);
  assert.deepEqual(await frames.refresh(), {frameSequence: 2, inputSequence: 0});
});

test("a failed input is reported without blocking later input or refresh", async () => {
  const failure = new Error("Input unavailable");
  const errors: unknown[] = [];
  const sent: string[] = [];
  const captures: {sequence: number; input: number; sent: string[]}[] = [];
  const shown: number[] = [];
  const frames = createFrameQueue<string, number>({
    settleMs: 10,
    send: async value => {
      if (value === "failed") throw failure;
      sent.push(value);
    },
    capture: (sequence, input) => { captures.push({sequence, input, sent: [...sent]}); return input; },
    display: frame => { shown.push(frame); },
    onError: error => { errors.push(error); },
  });
  await Promise.all([frames.post("failed"), frames.post("recovered")]);
  const result = await frames.refresh();
  assert.deepEqual(errors, [failure]);
  assert.deepEqual(sent, ["recovered"]);
  assert.deepEqual(captures, [{sequence: 1, input: 2, sent: ["recovered"]}]);
  assert.deepEqual(shown, [2]);
  assert.deepEqual(result, {frameSequence: 1, inputSequence: 2});
});

test("asynchronous captures and displays serialize and discard each frame after display", async () => {
  const captures: ReturnType<typeof deferred<string>>[] = [];
  const displays: ({frame: string} & ReturnType<typeof deferred<void>>)[] = [];
  const discarded: string[] = [];
  let activeCaptures = 0;
  let maximumCaptures = 0;
  const frames = createFrameQueue<string, string>({
    settleMs: 0,
    send: async () => {},
    capture: async () => {
      const capture = deferred<string>();
      captures.push(capture);
      activeCaptures++;
      maximumCaptures = Math.max(maximumCaptures, activeCaptures);
      try { return await capture.promise; }
      finally { activeCaptures--; }
    },
    display: frame => {
      const display = deferred<void>();
      displays.push({frame, ...display});
      return display.promise;
    },
    discard: frame => { discarded.push(frame); },
  });
  const first = frames.refresh();
  await until(() => captures.length === 1);
  let secondComplete = false;
  const second = frames.refresh().then(result => { secondComplete = true; return result; });
  captures[0].resolve("first frame");
  await until(() => displays.length === 1);
  assert.equal(captures.length, 1);
  assert.deepEqual(discarded, []);
  displays[0].resolve();
  assert.deepEqual(await first, {frameSequence: 1, inputSequence: 0});
  await until(() => captures.length === 2);
  assert.equal(secondComplete, false);
  assert.deepEqual(discarded, ["first frame"]);
  captures[1].resolve("second frame");
  await until(() => displays.length === 2);
  assert.deepEqual(displays.map(display => display.frame), ["first frame", "second frame"]);
  assert.deepEqual(discarded, ["first frame"]);
  displays[1].resolve();
  assert.deepEqual(await second, {frameSequence: 2, inputSequence: 0});
  assert.equal(maximumCaptures, 1);
  assert.equal(activeCaptures, 0);
  assert.deepEqual(discarded, ["first frame", "second frame"]);
});

test("display failures discard the captured frame and allow a later retry", async () => {
  const discarded: string[] = [];
  let attempts = 0;
  const frames = createFrameQueue<string, string>({
    settleMs: 0,
    send: async () => {},
    capture: () => `frame ${++attempts}`,
    display: async frame => { if (frame === "frame 1") throw new Error("Display unavailable"); },
    discard: frame => { discarded.push(frame); },
  });
  await assert.rejects(frames.refresh(), /Display unavailable/);
  assert.deepEqual(discarded, ["frame 1"]);
  assert.deepEqual(await frames.refresh(), {frameSequence: 2, inputSequence: 0});
  assert.deepEqual(discarded, ["frame 1", "frame 2"]);
});
