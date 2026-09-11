import {execFile} from "node:child_process";
import {promisify} from "node:util";

const execute = promisify(execFile);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasErrorCode(error: unknown, code: string | number): boolean {
  return isRecord(error) && error.code === code;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runDesktopCommand(program: string, args: string[], maxBuffer = 4 * 1024 * 1024): Promise<string> {
  return (await execute(program, args, {encoding: "utf8", timeout: 5000, maxBuffer})).stdout;
}

export function currentUserId(): number {
  if (!process.getuid) throw new Error("Super Space desktop integration requires Linux");
  return process.getuid();
}
