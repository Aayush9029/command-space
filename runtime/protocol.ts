import { StringDecoder } from "node:string_decoder";
import { errorCode, isRecord, type RuntimeMessage, type ValueRecord } from "./types.ts";

export { isRecord };
export type Values = ValueRecord;
export type WireMessage = RuntimeMessage;
export interface LaunchMessage extends WireMessage {
  type: "launch";
  extension: string;
  command: string;
  launchType?: "background" | "userInitiated";
  scheduled?: boolean;
  openPreferences?: boolean;
  setupComplete?: boolean;
  preferences?: Values;
  arguments?: Values | null;
  launchContext?: unknown;
  fallbackText?: string;
}
export interface EventMessage extends WireMessage {
  type: "event";
  callback: string;
  args?: unknown[];
  field?: string;
  inputRevision?: number;
}
export interface ResponseMessage extends WireMessage {
  type: "response";
  id: string;
  error?: string;
  value?: unknown;
}
export type InputMessage = LaunchMessage | EventMessage | ResponseMessage | { type: "stop" | "pop" | "preferences" };
export interface RenderNode {
  id: string;
  type: string;
  props: Values;
  children: RenderNode[];
}

export const errorMessage = (error: unknown): string => error instanceof Error ? error.stack || error.message : String(error);
export const hasErrorCode = (error: unknown, code: string): boolean => errorCode(error) === code;

function optional(value: Values, key: string, valid: (value: unknown) => boolean): void {
  if (value[key] !== undefined && !valid(value[key])) throw new Error(`Invalid extension message ${key}`);
}

export function inputMessage(value: unknown): InputMessage {
  if (!isRecord(value)) throw new Error("Extension message must be an object");
  switch (value.type) {
    case "launch":
      if (typeof value.extension !== "string" || !value.extension || typeof value.command !== "string" || !value.command) throw new Error("Extension launch requires an extension and command");
      optional(value, "launchType", item => item === "background" || item === "userInitiated");
      for (const key of ["scheduled", "openPreferences", "setupComplete"]) optional(value, key, item => typeof item === "boolean");
      optional(value, "preferences", isRecord);
      optional(value, "arguments", item => item === null || isRecord(item));
      optional(value, "fallbackText", item => typeof item === "string");
      return value as LaunchMessage;
    case "event":
      if (typeof value.callback !== "string") throw new Error("Extension event requires a callback");
      optional(value, "args", Array.isArray);
      optional(value, "field", item => typeof item === "string");
      optional(value, "inputRevision", item => typeof item === "number" && Number.isSafeInteger(item) && item >= 0);
      return value as EventMessage;
    case "response":
      if (typeof value.id !== "string") throw new Error("Extension response requires an id");
      optional(value, "error", item => typeof item === "string");
      return value as ResponseMessage;
    case "stop": case "pop": case "preferences": return { type: value.type };
    default: throw new Error(`Unknown extension message type: ${String(value.type)}`);
  }
}

export function outputMessage(value: unknown): WireMessage {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("Extension output must be a typed object");
  return value as WireMessage;
}

export function renderTree(value: unknown, depth = 0): RenderNode[] {
  if (!Array.isArray(value) || depth > 256) throw new Error("Invalid extension render tree");
  return value.map((node: unknown) => {
    if (!isRecord(node) || typeof node.id !== "string" || typeof node.type !== "string" || !isRecord(node.props)) throw new Error("Invalid extension render node");
    return { id: node.id, type: node.type, props: node.props, children: renderTree(node.children ?? [], depth + 1) };
  });
}

export async function* protocolLines(stream: AsyncIterable<Uint8Array | string>, limit = 1024 * 1024): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let bytes = 0;
  for await (const chunk of stream) {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      const segment = text.slice(start, newline < 0 ? text.length : newline);
      bytes += Buffer.byteLength(segment);
      if (bytes > limit) throw new Error(`Extension protocol line exceeds ${limit} bytes`);
      pending += segment;
      if (newline < 0) break;
      yield pending.endsWith("\r") ? pending.slice(0, -1) : pending;
      pending = "";
      bytes = 0;
      start = newline + 1;
    }
  }
  pending += decoder.end();
  if (Buffer.byteLength(pending) > limit) throw new Error(`Extension protocol line exceeds ${limit} bytes`);
  if (pending) yield pending;
}
