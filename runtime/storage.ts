import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {randomBytes} from "node:crypto";
import {errorCode, isRecord, type ValueRecord} from "./types.ts";

export function readStore(file: string): ValueRecord {
  try {
    const values: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isRecord(values)) throw new Error(`Storage file must contain a JSON object: ${file}`);
    return values;
  }
  catch (error) { if (errorCode(error) === "ENOENT") return {}; throw error; }
}

export function updateStore<T>(file: string, change: (values: ValueRecord) => T): T {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const descriptor = fs.openSync(`${file}.lock`, "a", 0o600);
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    // The inherited descriptor shares its lock with this process and releases it even after a crash.
    execFileSync("flock", ["--exclusive", "--timeout", "5", "3"], {
      stdio: ["ignore", "ignore", "pipe", descriptor], timeout: 6000,
    });
    const values = readStore(file);
    const result = change(values);
    fs.writeFileSync(temporary, JSON.stringify(values), {mode: 0o600, flag: "wx"});
    fs.renameSync(temporary, file);
    return result;
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(temporary, {force: true});
  }
}
