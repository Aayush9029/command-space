import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { consumeOperation, windowsConfiguration, sshKeys, discoverEncryptedDrives } from "../src/system-workflows.mjs";
import { run } from "../src/workflows.mjs";

export function terminalRun(command, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"] });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`Operation exited with status ${code}`)));
  });
}

export async function performOperation(operation, { execute = terminalRun, inspect = run, verifyBlockDevice = async file => (await fs.stat(file)).isBlockDevice() } = {}) {
  const { values } = operation;
  if (operation.operation === "sshd") {
    const keys = await sshKeys({ source: "manual", key: values.keys?.join("\n") }, { execute: inspect });
    for (const key of keys) await execute("/usr/bin/omarchy-setup-security-sshd", [`--key=${key}`]);
  } else if (operation.operation === "windows") {
    const config = windowsConfiguration(values);
    const data = [config.ram, config.cores, config.disk, config.username, config.password].join("\0") + "\0";
    await execute("/usr/bin/bash", [path.join(path.dirname(fileURLToPath(import.meta.url)), "windows-install.sh")], { input: data });
  } else if (operation.operation === "drive-password") {
    if (!values.password || /[\x00-\x1f\x7f]/.test(values.password)) throw new Error("Invalid new passphrase");
    if (!(await discoverEncryptedDrives(inspect)).some(drive => drive.path === values.drive) || !await verifyBlockDevice(values.drive)) throw new Error("Encrypted drive is no longer available");
    await execute("sudo", ["/usr/bin/bash", "-c", 'exec cryptsetup luksChangeKey --pbkdf argon2id --iter-time 2000 "$1" <(cat) </dev/tty', "bash", values.drive], { input: values.password });
  } else throw new Error("Unknown operation");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const operation = await consumeOperation(process.argv[2]);
    await performOperation(operation);
    process.stdout.write("\nCompleted.\n");
  } catch (error) { process.stderr.write(`\n${error.message}\n`); process.exitCode = 1; }
  if (process.stdin.isTTY) {
    process.stdout.write("Press Enter to close.\n");
    process.stdin.resume();
    await new Promise(resolve => process.stdin.once("data", resolve));
    process.stdin.pause();
  }
}
