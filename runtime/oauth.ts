import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { errorCode, getRuntimeContext, isRecord } from "./types.ts";

export type CredentialAccess = (args: string[], input?: string) => Promise<string | undefined>;

export const keyring: CredentialAccess = (args, input) => new Promise((resolve, reject) => {
  const child = spawn("secret-tool", args, {stdio: ["pipe", "pipe", "pipe"]});
  let output = "", error = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  child.stderr.on("data", (chunk: string) => { error += chunk; });
  child.on("error", reject);
  child.stdin.on("error", reject);
  child.on("close", code => code === 0 ? resolve(output.trim()) : code === 1 && !error ? resolve(undefined) : reject(new Error(error || "Could not access the desktop keyring")));
  child.stdin.end(input);
});

const legacyApplication = "command-space";
const applicationAttributes = (application: string, attributes: string[]): string[] => ["application", application, ...attributes];

export async function lookupCredential(attributes: string[], label: string, access: CredentialAccess = keyring): Promise<string | undefined> {
  const current = applicationAttributes("super-space", attributes);
  const value = await access(["lookup", ...current]);
  if (value) return value;
  const legacy = applicationAttributes(legacyApplication, attributes);
  const previous = await access(["lookup", ...legacy]);
  if (!previous) return undefined;
  await access(["store", `--label=${label}`, ...current], previous);
  await access(["clear", ...legacy]);
  return previous;
}

export async function clearCredential(attributes: string[], access: CredentialAccess = keyring): Promise<void> {
  for (const application of [legacyApplication, "super-space"]) {
    await access(["clear", ...applicationAttributes(application, attributes)]);
  }
}

export const RedirectMethod = { Web: "web", App: "app", AppURI: "appURI", ClientIdMetadataDocument: "clientIdMetadataDocument" } as const;
export type RedirectMethod = typeof RedirectMethod[keyof typeof RedirectMethod];
export const clientIdMetadataDocument = "https://www.raycast.com/.well-known/oauth-client-metadata/raycast.json";

export interface PKCEClientOptions {
  providerName: string;
  providerId?: string;
  description?: string;
  redirectMethod?: RedirectMethod;
}

export interface AuthorizationRequestOptions {
  endpoint: string;
  clientId?: string;
  scope?: string;
  extraParameters?: Record<string, string>;
}

export interface AuthorizationRequest {
  clientId: string;
  codeVerifier: string;
  codeChallenge: string;
  state: string;
  redirectURI: string;
  toURL(): string;
}

export type AuthorizeOptions = {toURL(): string; url?: string} | {url: string; toURL?: () => string};

export interface TokenOptions {
  accessToken?: string;
  access_token?: string;
  refreshToken?: string;
  refresh_token?: string;
  idToken?: string;
  id_token?: string;
  expiresIn?: number | string;
  expires_in?: number | string;
  scope?: string;
  tokenType?: string;
  token_type?: string;
}

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn?: number | string;
  scope?: string;
  tokenType?: string;
  updatedAt: string;
}

export interface TokenSet extends Omit<StoredTokens, "updatedAt"> {
  updatedAt: Date;
  isExpired(): boolean;
}

function parseTokens(value: unknown): TokenSet {
  if (!isRecord(value) || typeof value.accessToken !== "string" || !value.accessToken) {
    throw new Error("Stored OAuth tokens must contain an access token");
  }
  const {accessToken, refreshToken, idToken, expiresIn, scope, tokenType, updatedAt} = value;
  if ((refreshToken !== undefined && typeof refreshToken !== "string") ||
      (idToken !== undefined && typeof idToken !== "string") ||
      (scope !== undefined && typeof scope !== "string") ||
      (tokenType !== undefined && typeof tokenType !== "string") ||
      (expiresIn !== undefined && ((typeof expiresIn !== "number" && typeof expiresIn !== "string") || !Number.isFinite(Number(expiresIn)))) ||
      typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt))) {
    throw new Error("Stored OAuth tokens contain invalid metadata");
  }
  const tokens: TokenSet = {accessToken, refreshToken, idToken, expiresIn, scope, tokenType, updatedAt: new Date(updatedAt),
    isExpired: () => tokens.expiresIn !== undefined && Date.now() >= tokens.updatedAt.getTime() + Number(tokens.expiresIn) * 1000};
  return tokens;
}

export class PKCEClient {
  constructor(readonly options: PKCEClientOptions) {}

  async authorizationRequest(options: AuthorizationRequestOptions): Promise<AuthorizationRequest> {
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const state = randomBytes(32).toString("base64url");
    const redirectURI = this.options.redirectMethod === RedirectMethod.App ? "raycast://oauth?package_name=Extension"
      : this.options.redirectMethod === RedirectMethod.AppURI ? "com.raycast:/oauth?package_name=Extension"
      : "https://raycast.com/redirect?packageName=Extension";
    const clientId = options.clientId || (this.options.redirectMethod === RedirectMethod.ClientIdMetadataDocument ? clientIdMetadataDocument : undefined);
    if (!clientId) throw new Error("OAuth client ID is required");
    const url = new URL(options.endpoint);
    for (const [key, value] of Object.entries({ response_type: "code", client_id: clientId, scope: options.scope || "", state, redirect_uri: redirectURI,
      code_challenge: codeChallenge, code_challenge_method: "S256", ...options.extraParameters })) url.searchParams.set(key, value);
    return { clientId: url.searchParams.get("client_id") ?? clientId, codeVerifier, codeChallenge,
      state: url.searchParams.get("state") ?? state, redirectURI: url.searchParams.get("redirect_uri") ?? redirectURI, toURL: () => url.href };
  }

  async authorize(options: AuthorizeOptions): Promise<{authorizationCode: string}> {
    const url = options.toURL ? options.toURL() : options.url;
    if (!url) throw new Error("OAuth authorization URL is required");
    const state = new URL(url).searchParams.get("state");
    if (!state) throw new Error("OAuth authorization URL must contain state");
    const bridge = getRuntimeContext();
    const accepted = await bridge.request<boolean>("confirm", { title: `Connect to ${this.options.providerName}`, message: this.options.description || "Open your browser to authorize this extension.", primaryAction: {title: "Open Browser"}, dismissAction: {title: "Cancel"} });
    if (!accepted) throw new Error("Authorization canceled");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Authorization timed out. Please try again.")), 10 * 60 * 1000);
    try {
      const pending = bridge.request<string>("oauth", { state, provider: this.options.providerName }, controller.signal);
      const browser = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
      browser.on("error", error => controller.abort(new Error(`Opening authorization page: ${error.message}`)));
      browser.on("exit", code => { if (code !== 0) controller.abort(new Error("Could not open the authorization page")); });
      const callback = new URL(await pending);
      const received = callback.searchParams.get("state") || "";
      if (Buffer.byteLength(received) !== Buffer.byteLength(state) || !timingSafeEqual(Buffer.from(received), Buffer.from(state))) throw new Error("OAuth state did not match the authorization request");
      if (callback.searchParams.has("error")) throw new Error(callback.searchParams.get("error_description") || callback.searchParams.get("error") || "Authorization failed");
      const authorizationCode = callback.searchParams.get("code");
      if (!authorizationCode) throw new Error("The provider did not return an authorization code");
      return { authorizationCode };
    } finally {
      clearTimeout(timeout);
    }
  }

  file(): string {
    const provider = createHash("sha256").update(this.options.providerId || this.options.providerName || "default").digest("hex");
    return path.join(getRuntimeContext().environment.supportPath, "oauth", `${provider}.json`);
  }

  attributes(): string[] {
    return ["extension", getRuntimeContext().environment.extensionName, "provider", this.options.providerId || this.options.providerName || "default"];
  }

  async setTokens(options: TokenOptions): Promise<void> {
    const accessToken = options.accessToken ?? options.access_token;
    if (!accessToken) throw new Error("An access token is required");
    const tokens: StoredTokens = { accessToken, refreshToken: options.refreshToken ?? options.refresh_token, idToken: options.idToken ?? options.id_token,
      expiresIn: options.expiresIn ?? options.expires_in, scope: options.scope, tokenType: options.tokenType ?? options.token_type, updatedAt: new Date().toISOString() };
    parseTokens(tokens);
    if (process.env.SUPER_SPACE_TOKEN_STORAGE !== "file") {
      await keyring(["store", `--label=Super Space · ${this.options.providerName}`, "application", "super-space", ...this.attributes()], JSON.stringify(tokens));
      await keyring(["clear", "application", legacyApplication, ...this.attributes()]);
      return;
    }
    const file = this.file();
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(tokens), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, {force: true});
    }
  }

  async getTokens(): Promise<TokenSet | undefined> {
    let value: unknown;
    if (process.env.SUPER_SPACE_TOKEN_STORAGE !== "file") {
      const credential = await lookupCredential(this.attributes(), `Super Space · ${this.options.providerName}`);
      if (!credential) return undefined;
      value = JSON.parse(credential);
    } else {
      try { value = JSON.parse(await fs.readFile(this.file(), "utf8")); }
      catch (error) { if (errorCode(error) === "ENOENT") return undefined; throw error; }
    }
    return parseTokens(value);
  }

  async removeTokens(): Promise<void> {
    if (process.env.SUPER_SPACE_TOKEN_STORAGE !== "file") await clearCredential(this.attributes());
    else await fs.rm(this.file(), {force: true});
  }
}

export const OAuth = { PKCEClient, RedirectMethod, clientIdMetadataDocument };
