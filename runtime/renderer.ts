import React, { type ReactNode } from "react";
import Reconciler from "react-reconciler";
import { DefaultEventPriority } from "react-reconciler/constants.js";
import { createImages } from "./images.ts";
import { isRecord, type ValueRecord } from "./types.ts";

type Callback = (...args: unknown[]) => unknown;

interface RenderNode {
  id: string;
  type: string;
  props: ValueRecord;
  initialValue?: unknown;
  children: RenderNode[];
  hidden?: boolean;
}

interface RenderRoot {
  children: RenderNode[];
}

export interface RenderSnapshot {
  id: string;
  type: string;
  props: ValueRecord;
  children: RenderSnapshot[];
}

export type RendererMessage =
  | { type: "render"; inputRevision: number; tree: RenderSnapshot[] }
  | { type: "field-command"; operation: "focus" | "reset"; id: unknown; value?: unknown }
  | { type: "error"; message: string };

interface FieldHandle {
  focus(): void;
  reset(): void;
}

declare module "react" {
  interface FragmentInstance {
    focus(): void;
    focusLast(): void;
  }
}

interface FragmentFiber {
  tag: number;
  child: FragmentFiber | null;
  sibling: FragmentFiber | null;
  stateNode: unknown;
}

const focusableFields = new Set([
  "Form.TextField", "Form.PasswordField", "Form.TextArea", "Form.Checkbox", "Form.DatePicker",
  "Form.Dropdown", "Form.TagPicker", "Form.FilePicker",
]);

export interface RendererEvent {
  field?: string;
  inputRevision?: number;
}

type HostConfig = Reconciler.HostConfig<
  string, ValueRecord, RenderRoot, RenderNode, RenderNode, never, never,
  RenderNode, FieldHandle, ValueRecord, never, ReturnType<typeof setTimeout>, -1, null
> & {
  bindToConsole(method: string, args: unknown[]): (...args: unknown[]) => void;
  maySuspendCommitOnUpdate(): boolean;
  maySuspendCommitInSyncRender(): boolean;
  suspendOnActiveViewTransition(): void;
  getSuspendedCommitReason(): null;
  createFragmentInstance(fiber: FragmentFiber): React.FragmentInstance;
  updateFragmentInstanceFiber(fiber: FragmentFiber, fragment: React.FragmentInstance): void;
  commitNewChildToFragmentInstance(child: RenderNode, fragment: React.FragmentInstance): void;
  deleteChildFromFragmentInstance(child: RenderNode, fragment: React.FragmentInstance): void;
};

function isCallback(value: unknown): value is Callback {
  return typeof value === "function";
}

export function createRenderer(emit: (message: RendererMessage) => void) {
  const images = createImages(() => publish());
  let nextId = 1;
  let eventPriority = DefaultEventPriority;
  let scheduled = false;
  let pendingFieldCommands: (() => void)[] = [];
  let inputRevision = 0;
  let previousCallbacks = new Map<string, Callback>();
  let callbacks = new Map<string, Callback>();
  const callbackIds = new WeakMap<Callback, string>();
  const hostNodes = new WeakSet<object>();
  const fragments = new WeakMap<React.FragmentInstance, Set<RenderNode>>();
  const root: RenderRoot = { children: [] };
  const visibleChildren = () => root.children.filter(node => !node.hidden).flatMap(node => node.type === "NavigationPage" ? (node.props.active ? node.children : []) : [node]).filter(node => !node.hidden);
  const append = (parent: RenderRoot, child: RenderNode): void => {
    const existing = parent.children.indexOf(child);
    if (existing >= 0) parent.children.splice(existing, 1);
    parent.children.push(child);
  };
  const insert = (parent: RenderRoot, child: RenderNode, before: RenderNode): void => {
    const existing = parent.children.indexOf(child);
    if (existing >= 0) parent.children.splice(existing, 1);
    const index = parent.children.indexOf(before);
    if (index < 0) parent.children.push(child);
    else parent.children.splice(index, 0, child);
  };
  const remove = (parent: RenderRoot, child: RenderNode): void => {
    const index = parent.children.indexOf(child);
    if (index >= 0) parent.children.splice(index, 1);
  };
  function createNode(node: RenderNode): RenderNode {
    hostNodes.add(node);
    return node;
  }
  function isHostNode(value: unknown): value is RenderNode {
    return typeof value === "object" && value !== null && hostNodes.has(value);
  }
  function isVisibleNode(target: RenderNode, nodes = root.children): boolean {
    return nodes.some(node => !node.hidden && (node.type !== "NavigationPage" || node.props.active) && (node === target || isVisibleNode(target, node.children)));
  }
  function afterPublish(command: () => void): void {
    if (scheduled) pendingFieldCommands.push(command);
    else command();
  }
  function fieldCommand(node: RenderNode, operation: "focus" | "reset"): void {
    afterPublish(() => {
      const id = node.props.id;
      if (typeof id !== "string" || !id || !isVisibleNode(node)) return;
      if (operation === "focus") emit({ type: "field-command", operation, id });
      else {
        const value = serialize(node.initialValue ?? (node.type === "Form.Checkbox" ? false : ["Form.FilePicker", "Form.TagPicker"].includes(node.type) ? [] : ""));
        emit({ type: "field-command", operation, id, value });
      }
    });
  }
  function fragmentChildren(fragment: FragmentFiber): Set<RenderNode> {
    const children = new Set<RenderNode>();
    const visit = (fiber: FragmentFiber | null): void => {
      for (let current = fiber; current; current = current.sibling) {
        if (current.tag === 4) continue;
        if (isHostNode(current.stateNode)) children.add(current.stateNode);
        else visit(current.child);
      }
    };
    visit(fragment.child);
    return children;
  }
  function focusFragment(fragment: React.FragmentInstance, last = false): void {
    afterPublish(() => {
      const children = fragments.get(fragment);
      if (!children?.size) return;
      let target: string | undefined;
      const visit = (nodes: RenderNode[], inside: boolean): void => {
        for (const node of nodes) {
          if ((!last && target !== undefined) || node.hidden || (node.type === "NavigationPage" && !node.props.active)) continue;
          const included = inside || children.has(node);
          if (included && focusableFields.has(node.type) && typeof node.props.id === "string" && node.props.id && !node.props.disabled) target = node.props.id;
          visit(node.children, included);
        }
      };
      // Placement hooks omit existing children moved by keyed reorders, so focus follows the live host tree.
      visit(root.children, false);
      if (target !== undefined) emit({ type: "field-command", operation: "focus", id: target });
    });
  }
  function serializeRecord(value: ValueRecord, seen = new Set<object>()): ValueRecord {
    seen.add(value);
    try {
      return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "_owner" && key !== "ref").map(([key, item]) => [key, serialize(item, seen)]));
    } finally {
      seen.delete(value);
    }
  }
  function serialize(value: unknown, seen = new Set<object>()): unknown {
    if (isCallback(value)) {
      let id = callbackIds.get(value);
      if (!id) { id = String(nextId++); callbackIds.set(value, id); }
      callbacks.set(id, value);
      return { $callback: id };
    }
    if (value === undefined || value === null || typeof value !== "object") return value;
    if (value instanceof Date) return value.toISOString();
    if (seen.has(value)) return null;
    if (isRecord(value) && !React.isValidElement(value)) return serializeRecord(value, seen);
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map(item => serialize(item, seen));
      if (React.isValidElement(value)) {
        const type = value.type;
        const hostType = (typeof type === "function" || (typeof type === "object" && type !== null)) && "hostType" in type && typeof type.hostType === "string" ? type.hostType : typeof type === "string" ? type : "Element";
        return { type: hostType, props: serialize(value.props, seen) };
      }
      return {};
    } finally {
      seen.delete(value);
    }
  }
  function snapshot(node: RenderNode): RenderSnapshot {
    return { id: node.id, type: node.type, props: images(serializeRecord(node.props)), children: node.children.filter(child => !child.hidden).map(snapshot) };
  }
  function publish(): void {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const fieldCommands = pendingFieldCommands;
      pendingFieldCommands = [];
      previousCallbacks = callbacks;
      callbacks = new Map();
      try {
        emit({ type: "render", inputRevision, tree: visibleChildren().map(snapshot) });
        for (const command of fieldCommands) command();
      } catch (error) {
        onError(error);
      }
    });
  }
  const config: HostConfig = {
    isPrimaryRenderer: true,
    supportsMutation: true,
    supportsPersistence: false,
    supportsHydration: false,
    getRootHostContext: () => ({}),
    getChildHostContext: context => context,
    getPublicInstance: node => ({
      focus() { fieldCommand(node, "focus"); },
      reset() { fieldCommand(node, "reset"); },
    }),
    prepareForCommit: () => null,
    resetAfterCommit: publish,
    preparePortalMount: () => {},
    getInstanceFromNode: () => null,
    beforeActiveInstanceBlur: () => {},
    afterActiveInstanceBlur: () => {},
    prepareScopeUpdate: () => {},
    getInstanceFromScope: () => null,
    createFragmentInstance: fiber => {
      const fragment: React.FragmentInstance = {
        focus() { focusFragment(fragment); },
        focusLast() { focusFragment(fragment, true); },
      };
      fragments.set(fragment, fragmentChildren(fiber));
      return fragment;
    },
    updateFragmentInstanceFiber: (fiber, fragment) => { fragments.set(fragment, fragmentChildren(fiber)); },
    commitNewChildToFragmentInstance: (child, fragment) => { fragments.get(fragment)?.add(child); },
    deleteChildFromFragmentInstance: (child, fragment) => { fragments.get(fragment)?.delete(child); },
    createInstance: (type, props) => createNode({ id: String(nextId++), type, props: cleanProps(props), initialValue: props.defaultValue ?? props.value, children: [] }),
    createTextInstance: text => createNode({ id: String(nextId++), type: "Text", props: { text }, children: [] }),
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
    maySuspendCommitOnUpdate: () => false,
    maySuspendCommitInSyncRender: () => false,
    preloadInstance: () => true,
    startSuspendingCommit: () => {},
    suspendInstance: () => {},
    suspendOnActiveViewTransition: () => {},
    getSuspendedCommitReason: () => null,
    waitForCommitToBeReady: () => null,
    NotPendingTransition: null,
    // Reconciler exposes React's internal context shape rather than its public Context type.
    HostTransitionContext: React.createContext(null) as unknown as Reconciler.ReactContext<null>,
    resetFormInstance: () => {},
    requestPostPaintCallback: callback => { setTimeout(() => callback(performance.now()), 0); },
    shouldAttemptEagerTransition: () => false,
    trackSchedulerEvent: () => {},
    resolveEventType: () => null,
    resolveEventTimeStamp: () => -1.1,
    bindToConsole: (_method, args) => console.error.bind(console, ...args),
  };
  const renderer = Reconciler(config);
  const onError = (error: unknown): void => emit({ type: "error", message: error instanceof Error ? error.stack || error.message : String(error) });
  const container = renderer.createContainer(root, 0, null, false, null, "", onError, onError, onError, () => {});
  return {
    render(element: ReactNode): void { renderer.updateContainer(element, container, null, null); },
    storedFormValues(values: ValueRecord): ValueRecord {
      const result: ValueRecord = {};
      const visit = (node: RenderNode): void => {
        if (node.hidden) return;
        const id = node.props.id;
        if (node.type.startsWith("Form.") && node.props.storeValue && typeof id === "string" && Object.hasOwn(values, id)) {
          Object.defineProperty(result, id, { value: values[id], enumerable: true, configurable: true, writable: true });
        }
        for (const child of node.children) visit(child);
      };
      for (const node of visibleChildren()) visit(node);
      return result;
    },
    formValues(values: ValueRecord): ValueRecord {
      const result = { ...values };
      const visit = (node: RenderNode): void => {
        if (node.hidden) return;
        const id = node.props.id;
        if (node.type === "Form.DatePicker" && typeof id === "string" && Object.hasOwn(result, id)) {
          const value = result[id];
          const date = value === null || value === undefined || value === "" ? null : value instanceof Date ? new Date(value) : typeof value === "string" || typeof value === "number" ? new Date(value) : new Date(NaN);
          if (date && !Number.isFinite(date.getTime())) throw new Error(`Enter a valid date for ${node.props.title || id}`);
          Object.defineProperty(result, id, { value: date, enumerable: true, configurable: true, writable: true });
        }
        for (const child of node.children) visit(child);
      };
      for (const node of visibleChildren()) visit(node);
      return result;
    },
    async invoke(id: unknown, args: unknown[] = [], event: RendererEvent = {}): Promise<void> {
      const revision = event.inputRevision;
      if (typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0) inputRevision = Math.max(inputRevision, revision);
      const findField = (nodes: RenderNode[]): Callback | undefined => {
        for (const node of nodes) {
          if (node.hidden) continue;
          if (node.props.id === event.field && node.type.startsWith("Form.") && isCallback(node.props.onChange)) return node.props.onChange;
          const callback = findField(node.children); if (callback) return callback;
        }
        return undefined;
      };
      const callback = (event.field && findField(visibleChildren())) || callbacks.get(String(id)) || previousCallbacks.get(String(id));
      if (!callback) throw new Error(`Action ${id} is no longer available`);
      await callback(...args);
    },
  };
}

function cleanProps(props: ValueRecord): ValueRecord {
  return Object.fromEntries(Object.entries(props).filter(([key]) => !["children", "ref"].includes(key)));
}
