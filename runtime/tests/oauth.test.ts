import test, {type TestContext} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {PKCEClient, RedirectMethod, clientIdMetadataDocument, keyring} from "../oauth.ts";

async function fixture(t: TestContext): Promise<{directory: string; client: PKCEClient}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "super-space-oauth-"));
  const previousContext = globalThis.__superSpace;
  const previousStorage = process.env.SUPER_SPACE_TOKEN_STORAGE;
  process.env.SUPER_SPACE_TOKEN_STORAGE = "file";
  globalThis.__superSpace = {environment: {supportPath: directory, extensionName: "fixture"}};
  t.after(async () => {
    globalThis.__superSpace = previousContext;
    if (previousStorage === undefined) delete process.env.SUPER_SPACE_TOKEN_STORAGE;
    else process.env.SUPER_SPACE_TOKEN_STORAGE = previousStorage;
    await fs.rm(directory, {recursive: true, force: true});
  });
  return {directory, client: new PKCEClient({providerName: "Fixture"})};
}

test("OAuth authorization requests keep PKCE and caller redirect parameters", async () => {
  const client = new PKCEClient({providerName: "Fixture", redirectMethod: RedirectMethod.ClientIdMetadataDocument});
  const request = await client.authorizationRequest({endpoint: "https://provider.example/authorize", scope: "read", extraParameters: {state: "override-state", redirect_uri: "https://example.invalid/redirect"}});
  const url = new URL(request.toURL());
  assert.equal(request.clientId, clientIdMetadataDocument);
  assert.equal(request.state, "override-state");
  assert.equal(request.redirectURI, "https://example.invalid/redirect");
  assert.equal(request.codeChallenge, createHash("sha256").update(request.codeVerifier).digest("base64url"));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), "read");
  await assert.rejects(new PKCEClient({providerName: "Fixture"}).authorizationRequest({endpoint: url.href}), /client ID is required/);
});

test("concurrent OAuth token writes publish complete private records without temporary files", async t => {
  const {client} = await fixture(t);
  await Promise.all(Array.from({length: 32}, (_, index) => client.setTokens({access_token: `token-${index}`, refresh_token: `refresh-${index}`, expires_in: 3600})));
  const tokens = await client.getTokens();
  assert.ok(tokens);
  const index = tokens.accessToken.slice("token-".length);
  assert.equal(tokens.refreshToken, `refresh-${index}`);
  assert.ok(tokens.updatedAt instanceof Date);
  assert.equal(tokens.isExpired(), false);
  assert.equal((await fs.stat(client.file())).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(client.file()))).mode & 0o777, 0o700);
  assert.deepEqual(await fs.readdir(path.dirname(client.file())), [path.basename(client.file())]);
  await client.removeTokens();
  assert.equal(await client.getTokens(), undefined);
  await client.removeTokens();
});

test("invalid OAuth updates preserve existing tokens and expiration remains explicit", async t => {
  const {client} = await fixture(t);
  await client.setTokens({accessToken: "saved", expiresIn: "0"});
  assert.equal((await client.getTokens())?.isExpired(), true);
  await assert.rejects(client.setTokens({accessToken: "invalid", expiresIn: "invalid"}), /invalid metadata/);
  await assert.rejects(client.setTokens({accessToken: ""}), /access token is required/);
  assert.equal((await client.getTokens())?.accessToken, "saved");
  await client.setTokens({accessToken: "no-expiry"});
  assert.equal((await client.getTokens())?.isExpired(), false);
});

test("malformed OAuth token files fail clearly without rewriting user data", async t => {
  const {client} = await fixture(t);
  await fs.mkdir(path.dirname(client.file()), {recursive: true});
  for (const value of [null, [], {accessToken: "token", updatedAt: "invalid"}, {accessToken: "token", updatedAt: new Date().toISOString(), expiresIn: {value: 1}}]) {
    const serialized = JSON.stringify(value);
    await fs.writeFile(client.file(), serialized);
    await assert.rejects(client.getTokens(), /Stored OAuth tokens/);
    assert.equal(await fs.readFile(client.file(), "utf8"), serialized);
  }
});

test("failed OAuth file publication removes only its temporary file", async t => {
  const {client} = await fixture(t);
  await fs.mkdir(client.file(), {recursive: true});
  const preserved = path.join(client.file(), "preserved");
  await fs.writeFile(preserved, "retained");
  await assert.rejects(client.setTokens({accessToken: "token"}));
  assert.equal(await fs.readFile(preserved, "utf8"), "retained");
  assert.deepEqual(await fs.readdir(path.dirname(client.file())), [path.basename(client.file())]);
});

test("keyring waits for complete UTF-8 output and reports command failures", async t => {
  const {directory} = await fixture(t);
  const executable = path.join(directory, "secret-tool");
  const previousPath = process.env.PATH;
  process.env.PATH = directory;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const secret = "🔐é".repeat(12000);
  await fs.writeFile(executable, `#!${process.execPath}\nif (process.argv[2] === "lookup") process.stdout.write(${JSON.stringify(secret)});\nelse if (process.argv[2] === "missing") process.exit(1);\nelse { process.stderr.write("Keyring locked"); process.exitCode = 2; }\n`, {mode: 0o700});
  assert.equal(await keyring(["lookup"]), secret);
  assert.equal(await keyring(["missing"]), undefined);
  await assert.rejects(keyring(["failure"]), /Keyring locked/);
});
