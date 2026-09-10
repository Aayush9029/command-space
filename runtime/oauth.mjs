import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";

const bridge = () => globalThis.__commandSpace;
export function keyring(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("secret-tool", args, {stdio:[input === undefined ? "ignore" : "pipe", "pipe", "pipe"]});
    let output = "", error = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(output.trim()) : code === 1 && !error ? resolve(undefined) : reject(new Error(error || "Could not access the desktop keyring")));
    if (input !== undefined) child.stdin.end(input);
  });
}
export const RedirectMethod = { Web:"web", App:"app", AppURI:"appURI", ClientIdMetadataDocument:"clientIdMetadataDocument" };
export const clientIdMetadataDocument = "https://www.raycast.com/.well-known/oauth-client-metadata/raycast.json";

export class PKCEClient {
  constructor(options) { this.options = options; }
  async authorizationRequest(options) {
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const state = randomBytes(32).toString("base64url");
    const redirectURI = this.options.redirectMethod === RedirectMethod.App ? "raycast://oauth?package_name=Extension"
      : this.options.redirectMethod === RedirectMethod.AppURI ? "com.raycast:/oauth?package_name=Extension"
      : "https://raycast.com/redirect?packageName=Extension";
    const clientId = options.clientId || (this.options.redirectMethod === RedirectMethod.ClientIdMetadataDocument ? clientIdMetadataDocument : undefined);
    if (!clientId) throw new Error("OAuth client ID is required");
    const url = new URL(options.endpoint);
    for (const [key, value] of Object.entries({ response_type:"code", client_id:clientId, scope:options.scope || "", state, redirect_uri:redirectURI,
      code_challenge:codeChallenge, code_challenge_method:"S256", ...options.extraParameters })) url.searchParams.set(key, value);
    return { clientId:url.searchParams.get("client_id"), codeVerifier, codeChallenge, state:url.searchParams.get("state"), redirectURI:url.searchParams.get("redirect_uri"), toURL:() => url.href };
  }
  async authorize(options) {
    const url = options.toURL ? options.toURL() : options.url;
    const state = new URL(url).searchParams.get("state");
    if (!state) throw new Error("OAuth authorization URL must contain state");
    const accepted = await bridge().request("confirm", { title:`Connect to ${this.options.providerName}`, message:this.options.description || "Open your browser to authorize this extension.", primaryAction:{title:"Open Browser"}, dismissAction:{title:"Cancel"} });
    if (!accepted) throw new Error("Authorization canceled");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Authorization timed out. Please try again.")), 10 * 60 * 1000);
    const pending = bridge().request("oauth", { state, provider:this.options.providerName }, controller.signal);
    const browser = spawn("xdg-open", [url], { stdio:"ignore" });
    browser.on("error", error => controller.abort(new Error(`Opening authorization page: ${error.message}`)));
    browser.on("exit", code => { if (code) controller.abort(new Error("Could not open the authorization page")); });
    let callback;
    try { callback = new URL(await pending); } finally { clearTimeout(timeout); }
    const received = callback.searchParams.get("state") || "";
    if (Buffer.byteLength(received) !== Buffer.byteLength(state) || !timingSafeEqual(Buffer.from(received), Buffer.from(state))) throw new Error("OAuth state did not match the authorization request");
    if (callback.searchParams.has("error")) throw new Error(callback.searchParams.get("error_description") || callback.searchParams.get("error"));
    const authorizationCode = callback.searchParams.get("code");
    if (!authorizationCode) throw new Error("The provider did not return an authorization code");
    return { authorizationCode };
  }
  file() {
    const provider = createHash("sha256").update(this.options.providerId || this.options.providerName || "default").digest("hex");
    return path.join(bridge().environment.supportPath, "oauth", `${provider}.json`);
  }
  attributes() { return ["application","command-space","extension",bridge().environment.extensionName,"provider",this.options.providerId || this.options.providerName || "default"]; }
  async setTokens(options) {
    const accessToken = options.accessToken ?? options.access_token;
    if (!accessToken) throw new Error("An access token is required");
    const tokens = { accessToken, refreshToken:options.refreshToken ?? options.refresh_token, idToken:options.idToken ?? options.id_token,
      expiresIn:options.expiresIn ?? options.expires_in, scope:options.scope, tokenType:options.tokenType ?? options.token_type, updatedAt:new Date().toISOString() };
    if (process.env.COMMAND_SPACE_TOKEN_STORAGE !== "file") {
      await keyring(["store", `--label=Command Space · ${this.options.providerName}`, ...this.attributes()], JSON.stringify(tokens));
      return;
    }
    const file = this.file();
    await fs.mkdir(path.dirname(file), { recursive:true, mode:0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(tokens), { mode:0o600 });
    await fs.rename(temporary, file);
  }
  async getTokens() {
    let tokens;
    if (process.env.COMMAND_SPACE_TOKEN_STORAGE !== "file") {
      const value = await keyring(["lookup", ...this.attributes()]);
      if (!value) return undefined;
      tokens = JSON.parse(value);
    } else {
      try { tokens = JSON.parse(await fs.readFile(this.file(), "utf8")); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    }
    tokens.updatedAt = new Date(tokens.updatedAt);
    tokens.isExpired = () => tokens.expiresIn !== undefined && Date.now() >= tokens.updatedAt.getTime() + Number(tokens.expiresIn) * 1000;
    return tokens;
  }
  async removeTokens() {
    if (process.env.COMMAND_SPACE_TOKEN_STORAGE !== "file") await keyring(["clear", ...this.attributes()]);
    else await fs.rm(this.file(), {force:true});
  }
}

export const OAuth = { PKCEClient, RedirectMethod, clientIdMetadataDocument };
