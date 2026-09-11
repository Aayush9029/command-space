import type { ReactNode } from "react";

export type ValueRecord = Record<string, unknown>;

export interface RuntimeEnvironment {
  commandName: string;
  extensionName: string;
  ownerOrAuthorName: string;
  assetsPath: string;
  supportPath: string;
  isDevelopment: boolean;
  appearance: string;
  textSize: string;
  raycastVersion: string;
  commandMode: string;
  launchType: string;
  canAccess(capability: unknown): boolean;
}

export interface AIConfig {
  endpoint?: string;
  model?: string;
  models?: Record<string, string>;
}

export interface RuntimeMessage extends ValueRecord {
  type: string;
}

export interface RuntimeContext {
  environment: RuntimeEnvironment;
  preferences: ValueRecord;
  ai: AIConfig;
  extensionPath: string;
  launcherPath: string;
  emit(message: RuntimeMessage): void;
  formValues(values: ValueRecord): ValueRecord;
  storedFormValues(values: ValueRecord): ValueRecord;
  push(element: ReactNode, onPop?: () => void): void;
  pop(): void;
  root(): void;
  preferencesPanel(): void;
  request<T = unknown>(kind: string, options: ValueRecord, signal?: AbortSignal): Promise<T>;
}

export interface NativeProps extends ValueRecord {
  children?: ReactNode;
  actions?: ReactNode;
  detail?: ReactNode;
  metadata?: ReactNode;
  searchBarAccessory?: ReactNode;
}

declare global {
  var __superSpace: (Partial<Omit<RuntimeContext, "environment">> & { environment?: Partial<RuntimeEnvironment> }) | undefined;
}

export function getRuntimeContext(): RuntimeContext {
  const context = globalThis.__superSpace;
  if (!context) throw new Error("The extension runtime has not been initialized");
  // Invocation initializes the complete bridge before loading extension code.
  return context as RuntimeContext;
}

export function isRecord(value: unknown): value is ValueRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function errorCode(error: unknown): string | number | undefined {
  if (!isRecord(error)) return undefined;
  const code = error.code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}

export function recordValue(value: unknown): ValueRecord {
  return isRecord(value) ? value : {};
}
