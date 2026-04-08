import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

interface StoredToken extends TokenResponse {
  expires_at?: number;
  resource: string;
}

type TokenStore = Record<string, StoredToken>;

const STORE_PATH = join(homedir(), ".config", "mcp-inspector", "auth.json");
const ATLASSIAN_AUTH_SERVER = "https://auth.atlassian.com";
const ATLASSIAN_AUDIENCE = "api.atlassian.com";

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function sha256Base64Url(input: string): string {
  return base64Url(createHash("sha256").update(input).digest());
}

function isExpired(token: StoredToken): boolean {
  if (!token.expires_at) return false;
  return Date.now() >= token.expires_at - 60_000;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  if (platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    return;
  }
  if (platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    return;
  }
  spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
}

async function loadStore(): Promise<TokenStore> {
  try {
    const raw = await readFile(STORE_PATH, "utf8");
    return JSON.parse(raw) as TokenStore;
  } catch {
    return {};
  }
}

async function saveStore(store: TokenStore): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2) + "\n", "utf8");
}

async function fetchMetadata(): Promise<OAuthMetadata> {
  const response = await fetch(`${ATLASSIAN_AUTH_SERVER}/.well-known/oauth-authorization-server`);
  if (!response.ok) {
    throw new Error(`OAuth metadata fetch failed: ${response.status} ${response.statusText}`);
  }
  return await response.json() as OAuthMetadata;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for Atlassian OAuth. Set it before using Atlassian MCP.`);
  }
  return value;
}

function getRequestedScopes(): string | undefined {
  const scopes = process.env.ATLASSIAN_OAUTH_SCOPES?.trim();
  if (!scopes) return undefined;
  return scopes;
}

function buildAuthorizeUrl(
  metadata: OAuthMetadata,
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  state: string,
  resource: string
): string {
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("audience", ATLASSIAN_AUDIENCE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", resource);
  const scopes = getRequestedScopes();
  if (scopes) {
    url.searchParams.set("scope", scopes);
  }
  return url.toString();
}

async function startCallbackServer(state: string): Promise<{
  redirectUri: string;
  waitForCode: Promise<string>;
}> {
  return await new Promise((resolve, reject) => {
    let finished = false;
    let resolveCode: ((code: string) => void) | null = null;
    let rejectCode: ((error: Error) => void) | null = null;

    const waitForCode = new Promise<string>((innerResolve, innerReject) => {
      resolveCode = innerResolve;
      rejectCode = innerReject;
    });

    const server = createServer((req, res) => {
      const callbackUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const incomingState = callbackUrl.searchParams.get("state");
      const code = callbackUrl.searchParams.get("code");
      const error = callbackUrl.searchParams.get("error");

      if (finished) {
        res.statusCode = 409;
        res.end("Authentication is already completed.");
        return;
      }

      if (error) {
        finished = true;
        res.statusCode = 400;
        res.end("Authentication failed. You can close this tab.");
        server.close(() => rejectCode?.(new Error(`OAuth callback error: ${error}`)));
        return;
      }

      if (incomingState !== state || !code) {
        res.statusCode = 400;
        res.end("Invalid OAuth callback. You can close this tab.");
        return;
      }

      finished = true;
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Authentication completed. You can close this tab.");
      server.close(() => resolveCode?.(code));
    });

    server.on("error", (error) => {
      if (!finished) {
        finished = true;
        reject(error);
        rejectCode?.(error);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const timeout = setTimeout(() => {
        if (finished) return;
        finished = true;
        server.close(() => rejectCode?.(new Error("OAuth callback timed out after 5 minutes")));
      }, 5 * 60_000);

      waitForCode.finally(() => clearTimeout(timeout)).catch(() => undefined);
      resolve({ redirectUri, waitForCode });
    });
  });
}

async function exchangeCode(
  metadata: OAuthMetadata,
  clientId: string,
  clientSecret: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  resource: string
): Promise<StoredToken> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    resource,
  });

  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OAuth token exchange failed: ${response.status} ${text}`);
  }

  const token = await response.json() as TokenResponse;
  return {
    ...token,
    resource,
    expires_at: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
  };
}

async function refreshToken(
  metadata: OAuthMetadata,
  clientId: string,
  clientSecret: string,
  token: StoredToken
): Promise<StoredToken> {
  if (!token.refresh_token) {
    throw new Error("No refresh token available");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: token.refresh_token,
    resource: token.resource,
  });

  const scopes = getRequestedScopes();
  if (scopes) {
    body.set("scope", scopes);
  }

  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OAuth token refresh failed: ${response.status} ${text}`);
  }

  const refreshed = await response.json() as TokenResponse;
  return {
    ...token,
    ...refreshed,
    resource: token.resource,
    expires_at: refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : undefined,
  };
}

function normalizeResource(resourceUrl: string): string {
  const url = new URL(resourceUrl);
  return url.toString();
}

export async function getAtlassianAuthorizationHeader(resourceUrl: string): Promise<string> {
  const resource = normalizeResource(resourceUrl);
  const metadata = await fetchMetadata();
  const clientId = requireEnv("ATLASSIAN_OAUTH_CLIENT_ID");
  const clientSecret = requireEnv("ATLASSIAN_OAUTH_CLIENT_SECRET");

  const store = await loadStore();
  const existing = store[resource];

  if (existing && !isExpired(existing)) {
    return `Bearer ${existing.access_token}`;
  }

  if (existing?.refresh_token) {
    try {
      const refreshed = await refreshToken(metadata, clientId, clientSecret, existing);
      store[resource] = refreshed;
      await saveStore(store);
      return `Bearer ${refreshed.access_token}`;
    } catch {
      // Fall through to interactive authorization.
    }
  }

  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = sha256Base64Url(codeVerifier);
  const state = base64Url(randomBytes(24));

  const callback = await startCallbackServer(state);

  const authorizeUrl = buildAuthorizeUrl(
    metadata,
    clientId,
    callback.redirectUri,
    codeChallenge,
    state,
    resource
  );

  console.log(`\n[AUTH] Atlassian MCP authorization required`);
  console.log(`[AUTH] Open this URL in your browser:\n${authorizeUrl}\n`);
  try {
    openBrowser(authorizeUrl);
    console.log("[AUTH] Browser launch requested. Waiting for callback...");
  } catch {
    console.log("[AUTH] Browser launch failed. Open the URL manually.");
  }

  const code = await callback.waitForCode;
  const token = await exchangeCode(
    metadata,
    clientId,
    clientSecret,
    code,
    codeVerifier,
    callback.redirectUri,
    resource
  );

  store[resource] = token;
  await saveStore(store);
  console.log("[AUTH] Atlassian OAuth completed and token saved.");
  return `Bearer ${token.access_token}`;
}
