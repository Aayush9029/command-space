import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";

export function readStore(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}

export function updateStore(file, change) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const descriptor = fs.openSync(`${file}.lock`, "a", 0o600);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    // The inherited descriptor shares its lock with this process and releases it even after a crash.
    execFileSync("flock", ["--exclusive", "--timeout", "5", "3"], {
      stdio: ["ignore", "ignore", "pipe", descriptor], timeout: 6000,
    });
    const values = readStore(file);
    const result = change(values);
    fs.writeFileSync(temporary, JSON.stringify(values), {mode: 0o600});
    fs.renameSync(temporary, file);
    return result;
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(temporary, {force: true});
  }
}
