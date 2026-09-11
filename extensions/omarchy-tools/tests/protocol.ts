import assert from "node:assert/strict";
import { isRecord, renderTree, type RenderNode, type WireMessage } from "../../../runtime/protocol.ts";

export function nodes(tree: unknown): RenderNode[] {
  const flatten = (items: RenderNode[]): RenderNode[] => items.flatMap(node => [node, ...flatten(node.children)]);
  return flatten(renderTree(tree));
}

export function submitCallback(tree: unknown): string {
  const action = nodes(tree).find(node => node.type === "Action.SubmitForm");
  assert.ok(action, "Expected a submit action in the rendered form");
  const callback = action.props.onAction;
  assert.ok(isRecord(callback), "Expected a serialized submit callback");
  assert.ok(typeof callback.$callback === "string");
  return callback.$callback;
}

export function requestID(message: WireMessage): string {
  assert.ok(typeof message.id === "string");
  return message.id;
}

export function recordedCall(line: string): [string, string[]] {
  const call: unknown = JSON.parse(line);
  assert.ok(Array.isArray(call) && call.length === 2 && typeof call[0] === "string" && Array.isArray(call[1]));
  assert.ok(call[1].every((argument: unknown) => typeof argument === "string"));
  return call as [string, string[]];
}

export function recordedString(line: string): string {
  const value: unknown = JSON.parse(line);
  assert.ok(typeof value === "string");
  return value;
}
