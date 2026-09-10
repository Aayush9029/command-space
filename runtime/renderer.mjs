import React from "react";
import Reconciler from "react-reconciler";
import { DefaultEventPriority } from "react-reconciler/constants.js";
import { createImages } from "./images.mjs";

export function createRenderer(emit) {
  const images = createImages(() => publish());
  let nextId = 1;
  let eventPriority = DefaultEventPriority;
  let scheduled = false;
  let inputRevision = 0;
  let previousCallbacks = new Map();
  const callbacks = new Map();
  const callbackIds = new WeakMap();
  const root = { children: [] };
  const visibleChildren = () => root.children.flatMap(node => node.type === "NavigationPage" ? (node.props.active ? node.children : []) : [node]).filter(node => !node.hidden);
  const append = (parent, child) => {
    const existing = parent.children.indexOf(child);
    if (existing >= 0) parent.children.splice(existing, 1);
    parent.children.push(child);
  };
  const insert = (parent, child, before) => {
    const existing = parent.children.indexOf(child);
    if (existing >= 0) parent.children.splice(existing, 1);
    const index = parent.children.indexOf(before);
    if (index < 0) parent.children.push(child);
    else parent.children.splice(index, 0, child);
  };
  const remove = (parent, child) => {
    const index = parent.children.indexOf(child);
    if (index >= 0) parent.children.splice(index, 1);
  };
  function serialize(value, seen = new Set()) {
    if (typeof value === "function") {
      let id = callbackIds.get(value);
      if (!id) { id = String(nextId++); callbackIds.set(value, id); }
      callbacks.set(id, value);
      return { $callback: id };
    }
    if (value === undefined || value === null || typeof value !== "object") return value;
    if (value instanceof Date) return value.toISOString();
    if (seen.has(value)) return null;
    seen = new Set(seen).add(value);
    if (Array.isArray(value)) return value.map(v => serialize(v, seen));
    if (React.isValidElement(value)) {
      return { type: value.type?.hostType || (typeof value.type === "string" ? value.type : "Element"), props: serialize(value.props, seen) };
    }
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "_owner" && key !== "ref").map(([key, val]) => [key, serialize(val, seen)]));
  }
  function snapshot(node) {
    return { id: node.id, type: node.type, props: images(serialize(node.props)), children: node.children.filter(n => !n.hidden).map(snapshot) };
  }
  function publish() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      previousCallbacks = new Map(callbacks);
      callbacks.clear();
      emit({ type: "render", inputRevision, tree: visibleChildren().map(snapshot) });
    });
  }
  const renderer = Reconciler({
    isPrimaryRenderer: true,
    supportsMutation: true,
    supportsPersistence: false,
    supportsHydration: false,
    getRootHostContext: () => ({}),
    getChildHostContext: context => context,
    getPublicInstance: node => ({
      focus() { emit({ type: "field-command", operation: "focus", id: node.props.id }); },
      reset() {
        const value = serialize(node.initialValue ?? (node.type === "Form.Checkbox" ? false : ["Form.FilePicker", "Form.TagPicker"].includes(node.type) ? [] : ""));
        emit({ type: "field-command", operation: "reset", id: node.props.id, value });
      },
    }),
    prepareForCommit: () => null,
    resetAfterCommit: publish,
    createInstance: (type, props) => ({ id: String(nextId++), type, props: cleanProps(props), initialValue: props.defaultValue ?? props.value, children: [] }),
    createTextInstance: text => ({ id: String(nextId++), type: "Text", props: { text }, children: [] }),
    appendInitialChild: append,
    appendChild: append,
    appendChildToContainer: append,
    insertBefore: insert,
    insertInContainerBefore: insert,
    removeChild: remove,
    removeChildFromContainer: remove,
    finalizeInitialChildren: () => false,
    shouldSetTextContent: () => false,
    commitUpdate: (instance, _type, _old, next) => { instance.props = cleanProps(next); },
    commitTextUpdate: (instance, _old, next) => { instance.props.text = next; },
    resetTextContent: instance => { instance.children = []; },
    hideInstance: instance => { instance.hidden = true; },
    unhideInstance: instance => { instance.hidden = false; },
    hideTextInstance: instance => { instance.hidden = true; },
    unhideTextInstance: instance => { instance.hidden = false; },
    clearContainer: container => { container.children = []; },
    detachDeletedInstance: () => {},
    scheduleTimeout: setTimeout,
    cancelTimeout: clearTimeout,
    noTimeout: -1,
    supportsMicrotasks: true,
    scheduleMicrotask: queueMicrotask,
    getCurrentUpdatePriority: () => eventPriority,
    setCurrentUpdatePriority: priority => { eventPriority = priority; },
    resolveUpdatePriority: () => eventPriority || DefaultEventPriority,
    maySuspendCommit: () => false,
    preloadInstance: () => true,
    startSuspendingCommit: () => {},
    suspendInstance: () => {},
    waitForCommitToBeReady: () => null,
    NotPendingTransition: null,
    HostTransitionContext: React.createContext(null),
    resetFormInstance: () => {},
    requestPostPaintCallback: callback => setTimeout(callback, 0),
    shouldAttemptEagerTransition: () => false,
    trackSchedulerEvent: () => {},
    resolveEventType: () => null,
    resolveEventTimeStamp: () => -1.1,
    bindToConsole: (_method, args) => console.error.bind(console, ...args),
  });
  const onError = error => emit({ type: "error", message: error?.stack || String(error) });
  const container = renderer.createContainer(root, 0, null, false, null, "", onError, onError, onError, null);
  return {
    render(element) { renderer.updateContainer(element, container, null, null); },
    storedFormValues(values) {
      const result = {};
      const visit = node => {
        if (node.type.startsWith("Form.") && node.props.storeValue && node.props.id in values) result[node.props.id] = values[node.props.id];
        for (const child of node.children) visit(child);
      };
      for (const node of visibleChildren()) visit(node);
      return result;
    },
    formValues(values) {
      const result = { ...values };
      const visit = node => {
        if (node.type === "Form.DatePicker" && node.props.id in result) {
          result[node.props.id] = result[node.props.id] ? new Date(result[node.props.id]) : null;
          if (result[node.props.id] && !Number.isFinite(result[node.props.id].getTime())) throw new Error(`Enter a valid date for ${node.props.title || node.props.id}`);
        }
        for (const child of node.children) visit(child);
      };
      for (const node of visibleChildren()) visit(node);
      return result;
    },
    async invoke(id, args = [], event = {}) {
      inputRevision = Math.max(inputRevision, event.inputRevision || 0);
      const findField = nodes => {
        for (const node of nodes) {
          if (node.props.id === event.field && node.type.startsWith("Form.")) return node.props.onChange;
          const callback = findField(node.children); if (callback) return callback;
        }
      };
      const callback = (event.field && findField(visibleChildren())) || callbacks.get(String(id)) || previousCallbacks.get(String(id));
      if (!callback) throw new Error(`Action ${id} is no longer available`);
      await callback(...args);
    },
  };
}

function cleanProps(props) {
  return Object.fromEntries(Object.entries(props).filter(([key]) => !["children", "ref"].includes(key)));
}
