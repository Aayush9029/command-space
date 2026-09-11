import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { createRenderer, type RendererMessage, type RenderSnapshot } from "../renderer.ts";
import { SetupForm } from "../setup.ts";
import { isRecord, type ValueRecord } from "../types.ts";

type RenderMessage = Extract<RendererMessage, { type: "render" }>;

function harness() {
  const messages: RendererMessage[] = [];
  const renderer = createRenderer(message => { messages.push(message); });
  async function waitForRender(after: number, predicate: (message: RenderMessage) => boolean = () => true): Promise<RenderMessage> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      for (const message of messages.slice(after)) {
        if (message.type === "error") throw new Error(message.message);
        if (message.type === "render" && predicate(message)) return message;
      }
      await Bun.sleep(1);
    }
    throw new Error(`Renderer did not publish: ${JSON.stringify(messages)}`);
  }
  async function render(element: React.ReactNode): Promise<RenderMessage> {
    const after = messages.length;
    renderer.render(element);
    return waitForRender(after);
  }
  return { renderer, messages, render, waitForRender };
}

function callbackId(value: unknown): string {
  assert.ok(isRecord(value) && typeof value.$callback === "string");
  return value.$callback;
}

function nodeWithType(tree: RenderSnapshot[], type: string): RenderSnapshot {
  for (const node of tree) {
    if (node.type === type) return node;
    try { return nodeWithType(node.children, type); } catch {}
  }
  throw new Error(`Missing ${type}`);
}

test("renderer serializes shared values, cycles, dates, elements, and stable callbacks", async () => {
  const host = harness();
  const received: unknown[] = [];
  const callback = (value: unknown) => { received.push(value); };
  const shared = { value: "shared" };
  const cycle: ValueRecord = { label: "cycle" };
  cycle.self = cycle;
  const array: unknown[] = ["first"];
  array.push(array);
  const nativeComponent = Object.assign(() => null, { hostType: "Detail.Metadata.Label" });
  const first = await host.render(React.createElement("List", {
    payload: { left: shared, right: shared, cycle, array, date: new Date("2026-09-10T12:00:00Z"), _owner: "ignore", ref: "ignore" },
    onAction: callback,
    metadata: React.createElement(nativeComponent, { title: "Element" }),
    fragment: React.createElement(React.Fragment, null, "fragment text"),
  }));
  const props = nodeWithType(first.tree, "List").props;
  assert.deepEqual(props.payload, {
    left: shared, right: shared, cycle: { label: "cycle", self: null }, array: ["first", null], date: "2026-09-10T12:00:00.000Z",
  });
  assert.deepEqual(props.metadata, { type: "Detail.Metadata.Label", props: { title: "Element" } });
  assert.deepEqual(props.fragment, { type: "Element", props: { children: "fragment text" } });
  const id = callbackId(props.onAction);
  await host.renderer.invoke(id, ["called"]);
  assert.deepEqual(received, ["called"]);
  const second = await host.render(React.createElement("List", { onAction: callback }));
  assert.deepEqual(nodeWithType(second.tree, "List").props.onAction, props.onAction);
});

test("renderer keeps callbacks for one previous render and routes field events to current handlers", async () => {
  const host = harness();
  const received: string[] = [];
  const renderField = (label: string) => host.render(React.createElement("Form.TextField", { id: "name", onChange: () => { received.push(label); } }));
  const first = await renderField("first");
  const original = callbackId(first.tree[0]!.props.onChange);
  await renderField("second");
  await host.renderer.invoke(original);
  await host.renderer.invoke(original, [], { field: "name", inputRevision: 10 });
  const third = await renderField("third");
  assert.equal(third.inputRevision, 10);
  await assert.rejects(host.renderer.invoke(original), /no longer available/);
  await host.renderer.invoke(original, [], { field: "name", inputRevision: Number.NaN });
  await host.renderer.invoke(original, [], { field: "name", inputRevision: Infinity });
  await host.renderer.invoke(original, [], { field: "name", inputRevision: 3 });
  const fourth = await renderField("fourth");
  assert.equal(fourth.inputRevision, 10);
  assert.deepEqual(received, ["first", "second", "third", "third", "third"]);
});

test("form serialization preserves own field names and rejects invalid dates", async () => {
  const host = harness();
  await host.render(React.createElement("Form", null,
    React.createElement("Form.DatePicker", { id: "date", title: "Start Date", storeValue: true }),
    React.createElement("Form.TextField", { id: "__proto__", storeValue: true }),
    React.createElement("Form.TextField", { id: "constructor", storeValue: true }),
    React.createElement("Form.TextField", { id: "inherited", storeValue: true }),
    React.createElement("Form.TextField", { id: "temporary" }),
  ));
  const values: ValueRecord = { date: "2026-09-10T12:00:00Z", temporary: "omit", ["__proto__"]: "literal", constructor: "literal constructor" };
  Object.setPrototypeOf(values, { inherited: "omit inherited value" });
  const stored = host.renderer.storedFormValues(values);
  assert.deepEqual(stored, { date: values.date, ["__proto__"]: "literal", constructor: "literal constructor" });
  assert.equal(Object.getPrototypeOf(stored), Object.prototype);
  const parsed = host.renderer.formValues(values);
  assert.ok(parsed.date instanceof Date);
  assert.equal(parsed.date.toISOString(), "2026-09-10T12:00:00.000Z");
  assert.equal(values.date, "2026-09-10T12:00:00Z");
  assert.deepEqual(host.renderer.formValues({ date: "" }), { date: null });
  const epoch = host.renderer.formValues({ date: 0 }).date;
  assert.ok(epoch instanceof Date);
  assert.equal(epoch.getTime(), 0);
  for (const date of ["not a date", {}, false, new Date(NaN)]) {
    assert.throws(() => host.renderer.formValues({ date }), /Enter a valid date for Start Date/);
  }
});

test("only active navigation pages provide stored fields and serialized nodes", async () => {
  const host = harness();
  const result = await host.render(React.createElement(React.Fragment, null,
    React.createElement("NavigationPage", { active: false }, React.createElement("Form.TextField", { id: "hidden", storeValue: true })),
    React.createElement("NavigationPage", { active: true }, React.createElement("Form.TextField", { id: "visible", storeValue: true })),
  ));
  assert.deepEqual(result.tree.map(node => node.props.id), ["visible"]);
  assert.deepEqual(host.renderer.storedFormValues({ hidden: "hidden", visible: "visible" }), { visible: "visible" });
});

test("field refs preserve initial values after an update", async () => {
  const host = harness();
  const field = React.createRef<{ focus(): void; reset(): void }>();
  await host.render(React.createElement("Form.TextField", { id: "name", ref: field, defaultValue: "initial" }));
  await host.render(React.createElement("Form.TextField", { id: "name", ref: field, defaultValue: "updated" }));
  assert.ok(field.current);
  field.current.focus();
  field.current.reset();
  assert.deepEqual(host.messages.filter(message => message.type === "field-command"), [
    { type: "field-command", operation: "focus", id: "name" },
    { type: "field-command", operation: "reset", id: "name", value: "initial" },
  ]);
});

test("React transitions update native nodes with reconciler 0.34", async () => {
  const host = harness();
  function Command() {
    const [value, setValue] = React.useState("initial");
    return React.createElement("List.Item", { title: value, onAction: () => React.startTransition(() => { setValue("updated"); }) });
  }
  const initial = await host.render(React.createElement(Command));
  const after = host.messages.length;
  await host.renderer.invoke(callbackId(initial.tree[0]!.props.onAction));
  const updated = await host.waitForRender(after, message => message.tree[0]?.props.title === "updated");
  assert.equal(updated.tree[0]!.props.title, "updated");
});

test("setup form ignores duplicate submissions until the pending action settles", async () => {
  const host = harness();
  let submissions = 0;
  let finish: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const initial = await host.render(React.createElement(SetupForm, {
    title: "Setup", fields: [{ name: "name", type: "text", required: true }],
    onSubmit: async () => { submissions++; await pending; },
  }));
  const callback = callbackId(nodeWithType(initial.tree, "Action.SubmitForm").props.onAction);
  const first = host.renderer.invoke(callback, [{ name: "first" }]);
  const second = host.renderer.invoke(callback, [{ name: "second" }]);
  assert.equal(submissions, 1);
  assert.ok(finish);
  finish();
  await Promise.all([first, second]);
  await host.renderer.invoke(callback, [{ name: "third" }]);
  assert.equal(submissions, 2);
});

test("suspended components reveal native content after their promise resolves", async () => {
  const host = harness();
  let ready = false;
  let finish: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  function Content() {
    if (!ready) throw pending;
    return React.createElement("Detail", { markdown: "Ready" });
  }
  const first = await host.render(React.createElement(React.Suspense, { fallback: React.createElement("Detail", { markdown: "Loading" }) }, React.createElement(Content)));
  assert.equal(first.tree[0]!.props.markdown, "Loading");
  const after = host.messages.length;
  ready = true;
  assert.ok(finish);
  finish();
  const result = await host.waitForRender(after, message => message.tree[0]?.props.markdown === "Ready");
  assert.equal(result.tree.length, 1);
});

test("serialization errors are reported without stopping subsequent renders", async () => {
  const host = harness();
  await assert.rejects(host.render(React.createElement("Detail", { date: new Date(NaN) })), /date|time/i);
  const result = await host.render(React.createElement("Detail", { markdown: "Recovered" }));
  assert.equal(result.tree[0]!.props.markdown, "Recovered");
});

test("hidden Activity fields do not participate in form submission", async () => {
  const host = harness();
  const field = React.createElement("Form.DatePicker", { id: "hidden", storeValue: true });
  const view = (mode: "visible" | "hidden") => React.createElement("Form", null,
    React.createElement(React.Activity, { mode, children: field }),
    React.createElement("Form.TextField", { id: "visible", storeValue: true }),
  );
  await host.render(view("visible"));
  const hidden = await host.render(view("hidden"));
  assert.deepEqual(hidden.tree[0]!.children.map(node => node.props.id), ["visible"]);
  assert.deepEqual(host.renderer.storedFormValues({ hidden: "invalid date", visible: "value" }), { visible: "value" });
  assert.deepEqual(host.renderer.formValues({ hidden: "invalid date", visible: "value" }), { hidden: "invalid date", visible: "value" });
});

test("Fragment refs mount, update and unmount without replacing native content", async () => {
  const host = harness();
  const ref = React.createRef<React.FragmentInstance>();
  const view = (title: string) => React.createElement(React.Fragment, { ref }, React.createElement("List", { navigationTitle: title }, React.createElement("List.Item", { title })));
  const first = await host.render(view("Initial"));
  assert.equal(first.tree[0]?.type, "List");
  assert.equal(first.tree[0]?.children[0]?.props.title, "Initial");
  assert.ok(ref.current);
  const instance = ref.current;
  instance.focus();
  instance.focusLast();
  assert.deepEqual(host.messages.filter(message => message.type === "field-command"), []);
  const updated = await host.render(view("Updated"));
  assert.equal(updated.tree[0]?.children[0]?.props.title, "Updated");
  assert.equal(ref.current, instance);
  await host.render(null);
  assert.equal(ref.current, null);
  instance.focus();
  instance.focusLast();
  assert.deepEqual(host.messages.filter(message => message.type === "field-command"), []);
});

test("Fragment focus follows current child order through insertions, keyed moves and deletions", async () => {
  const host = harness();
  const ref = React.createRef<React.FragmentInstance>();
  const view = (ids: string[]) => React.createElement("Form", null,
    React.createElement("Form.TextField", { id: "outside-before" }),
    React.createElement(React.Fragment, { ref },
      React.createElement("Form.Description", { key: "description", id: "description", text: "Help" }),
      React.createElement("Form.TextField", { key: "empty-id", id: "" }),
      React.createElement("Form.TextField", { key: "disabled", id: "disabled", disabled: true }),
      ...ids.map(id => React.createElement("Form.TextField", { key: id, id })),
    ),
    React.createElement("Form.TextField", { id: "outside-after" }),
  );
  await host.render(view(["first", "second"]));
  assert.ok(ref.current);
  const instance = ref.current;
  const focusTargets = (): unknown[] => host.messages.filter(message => message.type === "field-command").map(message => message.id);
  instance.focus();
  instance.focusLast();
  assert.deepEqual(focusTargets(), ["first", "second"]);
  await host.render(view(["second", "first"]));
  assert.equal(ref.current, instance);
  instance.focus();
  instance.focusLast();
  assert.deepEqual(focusTargets().slice(-2), ["second", "first"]);
  await host.render(view(["third", "second", "first"]));
  instance.focus();
  assert.equal(focusTargets().at(-1), "third");
  await host.render(view(["first"]));
  instance.focus();
  instance.focusLast();
  assert.deepEqual(focusTargets().slice(-2), ["first", "first"]);
  await host.render(view([]));
  const count = focusTargets().length;
  instance.focus();
  instance.focusLast();
  assert.equal(focusTargets().length, count);
  await host.render(view(["restored"]));
  instance.focus();
  assert.equal(focusTargets().at(-1), "restored");
  await host.render(null);
  assert.equal(ref.current, null);
  const finalCount = focusTargets().length;
  instance.focus();
  assert.equal(focusTargets().length, finalCount);
});

test("Fragment focus reaches nested visible fields and is ready in child layout effects", async () => {
  const host = harness();
  const ref = React.createRef<React.FragmentInstance>();
  function Fields() {
    React.useLayoutEffect(() => { ref.current?.focusLast(); }, []);
    return React.createElement("Form", null,
      React.createElement("Form.TextField", { id: "nested-first" }),
      React.createElement("Form.TextField", { id: "nested-last" }),
    );
  }
  const view = (mode: "hidden" | "visible") => React.createElement(React.Fragment, { ref },
    React.createElement(React.Activity, { mode, children: React.createElement(Fields) }),
    React.createElement("Form.Checkbox", { id: "always-visible" }),
  );
  await host.render(view("visible"));
  assert.ok(ref.current);
  const instance = ref.current;
  const focusTargets = (): unknown[] => host.messages.filter(message => message.type === "field-command").map(message => message.id);
  assert.deepEqual(host.messages.map(message => message.type), ["render", "field-command"]);
  assert.deepEqual(focusTargets(), ["always-visible"]);
  instance.focus();
  assert.equal(focusTargets().at(-1), "nested-first");
  instance.focusLast();
  assert.equal(focusTargets().at(-1), "always-visible");
  await host.render(view("hidden"));
  instance.focus();
  assert.equal(focusTargets().at(-1), "always-visible");
  await host.render(view("visible"));
  instance.focus();
  assert.equal(focusTargets().at(-1), "nested-first");
});

test("field refs dispatch layout-effect commands after the native render", async () => {
  const host = harness();
  function Command() {
    const ref = React.useRef<{ focus(): void; reset(): void }>(null);
    React.useLayoutEffect(() => { ref.current?.focus(); ref.current?.reset(); }, []);
    return React.createElement("Form.TextField", { id: "mounted", defaultValue: "initial", ref });
  }
  await host.render(React.createElement(Command));
  assert.deepEqual(host.messages.map(message => message.type), ["render", "field-command", "field-command"]);
  assert.deepEqual(host.messages.slice(1), [
    { type: "field-command", operation: "focus", id: "mounted" },
    { type: "field-command", operation: "reset", id: "mounted", value: "initial" },
  ]);
});

test("field refs ignore a removed node even when its identifier is reused", async () => {
  const host = harness();
  const ref = React.createRef<{ focus(): void; reset(): void }>();
  await host.render(React.createElement("Form.TextField", { id: "shared", ref, defaultValue: "old" }));
  assert.ok(ref.current);
  const old = ref.current;
  await host.render(React.createElement("Form.PasswordField", { id: "shared", defaultValue: "new" }));
  old.focus();
  old.reset();
  assert.deepEqual(host.messages.filter(message => message.type === "field-command"), []);
});

test("field commands for a failed snapshot are discarded", async () => {
  const host = harness();
  function Command() {
    const ref = React.useRef<{ focus(): void; reset(): void }>(null);
    React.useLayoutEffect(() => { ref.current?.focus(); ref.current?.reset(); }, []);
    return React.createElement("Form.TextField", { id: "invalid", date: new Date(NaN), ref });
  }
  await assert.rejects(host.render(React.createElement(Command)), /date|time/i);
  assert.deepEqual(host.messages.map(message => message.type), ["error"]);
  await host.render(React.createElement("Form.TextField", { id: "invalid" }));
  assert.deepEqual(host.messages.filter(message => message.type === "field-command"), []);
});

test("commands queued during a commit ignore fields removed before publication", async () => {
  const host = harness();
  function Command() {
    const [replaced, replace] = React.useState(false);
    const ref = React.useRef<{ focus(): void; reset(): void }>(null);
    React.useLayoutEffect(() => {
      ref.current?.focus();
      ref.current?.reset();
      replace(true);
    }, []);
    return replaced
      ? React.createElement("Form.PasswordField", { id: "shared", defaultValue: "new" })
      : React.createElement("Form.TextField", { id: "shared", defaultValue: "old", ref });
  }
  const result = await host.render(React.createElement(Command));
  assert.equal(result.tree[0]?.type, "Form.PasswordField");
  assert.deepEqual(host.messages.filter(message => message.type === "field-command"), []);
});
