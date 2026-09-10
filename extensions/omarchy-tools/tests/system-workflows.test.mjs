import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dnsServers, configureDNS, sshKeys, windowsConfiguration, encryptedDrives, drivePassword, launchTerminalOperation, consumeOperation } from "../src/system-workflows.mjs";
import { performOperation } from "../assets/native-operation.mjs";
import { run } from "../src/workflows.mjs";
import { readBranding, writeBranding, resetBranding } from "../src/branding.mjs";

const assetsPath = fileURLToPath(new URL("../assets", import.meta.url));
const devices = JSON.stringify({ blockdevices: [{ name: "/dev/vda", children: [{ path: "/dev/vda2", fstype: "crypto_LUKS", size: "100G", label: "System" }] }] });
async function temporary(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "command-space-system-form-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

test("custom DNS validates addresses and supplies data to original stdin", async () => {
  assert.equal(dnsServers("1.1.1.1, 2606:4700:4700::1111 1.1.1.1"), "1.1.1.1 2606:4700:4700::1111");
  assert.equal(dnsServers("dns+tls://1.1.1.1#cloudflare-dns.com"), "dns+tls://1.1.1.1#cloudflare-dns.com");
  for (const value of ["", "example.com", "1.1.1.1; reboot", "1.1.1.1\nOther=bad", "999.1.1.1", "1.1.1.1#bad;command"]) assert.throws(() => dnsServers(value));
  let operation;
  await configureDNS({ servers: "192.168.1.1 1.1.1.1" }, { execute: async (...args) => { operation = args; } });
  assert.equal(operation[0], "omarchy-dns");
  assert.deepEqual(operation[1], ["Custom"]);
  assert.equal(operation[2].input, "192.168.1.1 1.1.1.1\n");
});

test("SSH keys are verified before any setup and GitHub imports stay bounded", async t => {
  const home = await temporary(t);
  const keyPath = path.join(home, "key");
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
  const key = (await fs.readFile(`${keyPath}.pub`, "utf8")).trim();
  assert.deepEqual(await sshKeys({ key }), [key]);
  await assert.rejects(sshKeys({ key: "ssh-ed25519 broken" }), /public key/);
  await assert.rejects(sshKeys({ source: "github", username: "../invalid" }), /GitHub username/);
  assert.deepEqual(await sshKeys({ source: "github", username: "fixture" }, { fetcher: async url => {
    assert.equal(url, "https://github.com/fixture.keys");
    return new Response(`${key}\n${key}\n`);
  } }), [key]);
  await assert.rejects(sshKeys({ source: "github", username: "fixture" }, { fetcher: async () => new Response("x".repeat(65537)) }), /too large/);
});

test("Windows resources and drive passphrases validate before terminal handoff", async () => {
  const config = { ram: "4G", disk: "64G", cores: "2", username: "test-user", password: "a $secret with 'quotes'" };
  assert.deepEqual(windowsConfiguration(config, { ram: 8, cores: 4 }), config);
  for (const values of [{ ...config, cores: "8" }, { ...config, ram: "16G" }, { ...config, username: "admin\nBAD" }, { ...config, password: "abc\nxyz" }, { ...config, password: "" }]) assert.throws(() => windowsConfiguration(values, { ram: 8, cores: 4 }));
  assert.deepEqual(encryptedDrives(devices), [{ path: "/dev/vda2", title: "/dev/vda2 · 100G · System" }]);
  const execute = async () => devices;
  assert.deepEqual(await drivePassword({ drive: "/dev/vda2", password: "new password", confirmation: "new password" }, { execute }), { drive: "/dev/vda2", password: "new password" });
  await assert.rejects(drivePassword({ drive: "/dev/vda1", password: "password", confirmation: "password" }, { execute }), /encrypted drive/);
  await assert.rejects(drivePassword({ drive: "/dev/vda2", password: "password", confirmation: "different" }, { execute }), /do not match/);
});

test("authentication handoff uses private one-use data and never places secrets in argv", async t => {
  let invocation;
  const password = "private value with $(literal)";
  const file = await launchTerminalOperation("drive-password", { drive: "/dev/vda2", password }, { assetsPath, execute: async (...args) => { invocation = args; } });
  t.after(() => fs.rm(path.dirname(file), { recursive: true, force: true }));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.equal(JSON.stringify(invocation).includes(password), false);
  assert.equal(invocation[0], "systemd-run");
  assert.equal(invocation[1].at(-1), file);
  assert.deepEqual(await consumeOperation(file), { operation: "drive-password", values: { drive: "/dev/vda2", password } });
  await assert.rejects(fs.access(file), { code: "ENOENT" });
  await assert.rejects(fs.access(path.dirname(file)), { code: "ENOENT" });
});

test("drive executor retains cryptsetup authentication on the terminal and sends only new key over stdin", async () => {
  let invocation;
  const password = "new passphrase";
  await performOperation({ operation: "drive-password", values: { drive: "/dev/vda2", password } }, {
    execute: async (...args) => { invocation = args; }, inspect: async () => devices, verifyBlockDevice: async () => true,
  });
  assert.equal(invocation[0], "sudo");
  assert.deepEqual(invocation[1], ["/usr/bin/bash", "-c", 'exec cryptsetup luksChangeKey --pbkdf argon2id --iter-time 2000 "$1" <(cat) </dev/tty', "bash", "/dev/vda2"]);
  assert.equal(invocation[2].input, password);
  assert.equal(JSON.stringify(invocation[1]).includes(password), false);
  await assert.rejects(performOperation({ operation: "drive-password", values: { drive: "/dev/vda2", password } }, {
    execute: async () => assert.fail("must not execute"), inspect: async () => devices, verifyBlockDevice: async () => false,
  }), /no longer available/);
});

test("Windows executor frames native settings on stdin without exposing its password", async () => {
  let invocation;
  const config = { ram: "2G", disk: "64G", cores: "1", username: "fixture", password: "literal $password\"'" };
  await performOperation({ operation: "windows", values: config }, { execute: async (...args) => { invocation = args; } });
  assert.equal(invocation[0], "/usr/bin/bash");
  assert.equal(invocation[1][0], path.join(assetsPath, "windows-install.sh"));
  assert.equal(invocation[2].input, [config.ram, config.cores, config.disk, config.username, config.password].join("\0") + "\0");
  assert.equal(JSON.stringify(invocation[1]).includes(config.password), false);
});

test("branding edits and resets use installed defaults without starting a legacy preview", async t => {
  const home = await temporary(t);
  const omarchyPath = path.join(home, "stock");
  await fs.mkdir(omarchyPath);
  await fs.writeFile(path.join(omarchyPath, "icon.txt"), "Stock About\n");
  await fs.writeFile(path.join(omarchyPath, "logo.txt"), "Stock Screensaver\n");
  const options = { home, omarchyPath };
  for (const target of ["about", "screensaver"]) {
    const stock = `Stock ${target === "about" ? "About" : "Screensaver"}\n`;
    assert.equal(await readBranding(target, options), stock);
    await writeBranding(target, "Custom\n  └── Text\n", options);
    assert.equal(await readBranding(target, options), "Custom\n  └── Text\n");
    await resetBranding(target, options);
    assert.equal(await readBranding(target, options), stock);
    assert.deepEqual((await fs.readdir(path.join(home, ".config/omarchy/branding"))).filter(name => name.endsWith(".tmp")), []);
  }
  await assert.rejects(writeBranding("../escape", "text", options), /Unknown branding/);
  await assert.rejects(writeBranding("about", "null\0byte", options), /null characters/);
});

test("original Windows install consumes native settings with every system action recorded", { skip: !fsSync.existsSync("/usr/bin/omarchy-windows-vm") }, async t => {
  const home = await temporary(t);
  await fs.mkdir(path.join(home, "bin"));
  await fs.writeFile(path.join(home, "bin/gum"), '#!/bin/sh\n[ "$1" = style ] || exit 99\n', { mode: 0o755 });
  const shell = `source() {
  builtin source "$@"
  prepare_user_mount_sources() { :; }
  check_prerequisites() { :; }
  available_storage_gb() { printf '1000\\n'; }
  omarchy-pkg-add() { printf '%s\\n' "$*" > "$HOME/packages"; }
  write_compose() { printf '%s\\0' "$@" > "$HOME/compose-input"; }
  write_credentials() { printf '%s\\0' "$@" > "$HOME/credential-input"; }
  priv() { printf '%s\\n' "$*" >> "$HOME/privileged-actions"; }
  xdg-open() { printf '%s\\n' "$*" > "$HOME/opened-url"; }
  sleep() { :; }
}
`;
  const setup = path.join(home, "setup.sh");
  await fs.writeFile(setup, shell);
  const values = ["2G", "1", "64G", "fixture", "literal $password with 'quotes'"];
  await run("/usr/bin/bash", [path.join(assetsPath, "windows-install.sh")], { input: values.join("\0") + "\0", env: { ...process.env, HOME: home, BASH_ENV: setup, PATH: `${home}/bin:${process.env.PATH}` } });
  const written = (await fs.readFile(path.join(home, "compose-input"), "utf8")).split("\0");
  assert.deepEqual(written.slice(0, 5), values);
  assert.equal((await fs.readFile(path.join(home, "privileged-actions"), "utf8")).trim(), "up");
  assert.equal((await fs.readFile(path.join(home, "opened-url"), "utf8")).trim(), "http://127.0.0.1:8006");
  assert.match(await fs.readFile(path.join(home, ".local/share/applications/windows-vm.desktop"), "utf8"), /^Exec=uwsm app -- omarchy-windows-vm launch$/m);
});

test("original SSH setup authorizes a key in a disposable home while privileged effects are recorded", { skip: !fsSync.existsSync("/usr/bin/omarchy-setup-security-sshd") }, async t => {
  const home = await temporary(t);
  const keyPath = path.join(home, "key");
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
  const key = (await fs.readFile(`${keyPath}.pub`, "utf8")).trim();
  const bin = path.join(home, "bin");
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "omarchy-pkg-add"), '#!/bin/sh\nprintf "%s\\n" "$*" > "$HOME/packages"\n', { mode: 0o755 });
  await fs.writeFile(path.join(bin, "omarchy-cmd-missing"), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const sudo = '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/sudo-calls"\nif [ "$1" = install ]; then cat > "$HOME/hardening"; fi\nif [ "$1" = sshd ] && [ "$2" = -T ]; then printf "passwordauthentication no\\nkbdinteractiveauthentication no\\n"; fi\nexit 0\n';
  await fs.writeFile(path.join(bin, "sudo"), sudo, { mode: 0o755 });
  await fs.writeFile(path.join(bin, "gum"), '#!/bin/sh\nprintf legacy-picker-invoked >&2\nexit 99\n', { mode: 0o755 });
  await run("/usr/bin/omarchy-setup-security-sshd", [`--key=${key}`], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal((await fs.readFile(path.join(home, ".ssh/authorized_keys"), "utf8")).trim(), key);
  assert.equal((await fs.stat(path.join(home, ".ssh/authorized_keys"))).mode & 0o777, 0o600);
  assert.match(await fs.readFile(path.join(home, "hardening"), "utf8"), /PasswordAuthentication no/);
  const effects = await fs.readFile(path.join(home, "sudo-calls"), "utf8");
  assert.match(effects, /systemctl enable --now sshd.service/);
  assert.match(effects, /ufw limit 22\/tcp/);
  assert.match(effects, /sshd -t/);
  assert.match(effects, /systemctl reload sshd.service/);
});
