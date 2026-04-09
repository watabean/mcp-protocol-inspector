import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";

export interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export interface OAuthToken extends TokenResponse {
  expires_at?: number;
}

interface StartCallbackServerOptions {
  port?: number;
  timeoutMs?: number;
}

interface ExchangeAuthorizationCodeOptions {
  metadata: OAuthMetadata;
  clientId: string;
  clientSecret?: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

interface RefreshAccessTokenOptions {
  metadata: OAuthMetadata;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  scope?: string;
}

interface AuthorizeUrlParams {
  metadata: OAuthMetadata;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  resource: string;
}

interface ExchangeCodeParams {
  metadata: OAuthMetadata;
  clientId: string;
  clientSecret?: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  resource: string;
}

interface RefreshTokenParams<TToken extends OAuthToken> {
  metadata: OAuthMetadata;
  clientId: string;
  clientSecret?: string;
  token: TToken;
  resource: string;
}

export interface OAuthProvider<TToken extends OAuthToken> {
  name: string;
  matches(url: URL): boolean;
  normalizeResource(resourceUrl: string): string;
  loadToken(resource: string): Promise<TToken | undefined>;
  saveToken(resource: string, token: TToken): Promise<void>;
  isTokenExpired(token: TToken): boolean;
  fetchMetadata(): Promise<OAuthMetadata>;
  getClientId(): string;
  getClientSecret?(): string | undefined;
  buildAuthorizeUrl(params: AuthorizeUrlParams): string;
  exchangeCode(params: ExchangeCodeParams): Promise<TToken>;
  refreshToken(params: RefreshTokenParams<TToken>): Promise<TToken>;
}

export function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function sha256Base64Url(input: string): string {
  return base64Url(createHash("sha256").update(input).digest());
}

export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64Url(randomBytes(32));
  return {
    codeVerifier,
    codeChallenge: sha256Base64Url(codeVerifier),
  };
}

export function createOAuthState(): string {
  return base64Url(randomBytes(24));
}

export function getExpiresAt(expiresIn?: number): number | undefined {
  return expiresIn ? Date.now() + expiresIn * 1000 : undefined;
}

export function openBrowser(url: string): void {
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

export async function startOAuthCallbackServer(
  state: string,
  options: StartCallbackServerOptions = {}
): Promise<{ redirectUri: string; waitForCode: Promise<string> }> {
  const port = options.port ?? 19876;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;

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

    server.listen(port, "127.0.0.1", () => {
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const timeout = setTimeout(() => {
        if (finished) return;
        finished = true;
        server.close(() => rejectCode?.(new Error("OAuth callback timed out after 5 minutes")));
      }, timeoutMs);

      waitForCode.finally(() => clearTimeout(timeout)).catch(() => undefined);
      resolve({ redirectUri, waitForCode });
    });
  });
}

export async function exchangeAuthorizationCode(
  options: ExchangeAuthorizationCodeOptions
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: options.clientId,
    code: options.code,
    code_verifier: options.codeVerifier,
    redirect_uri: options.redirectUri,
  });

  if (options.clientSecret) {
    body.set("client_secret", options.clientSecret);
  }

  return await requestToken(options.metadata, body, "OAuth token exchange failed");
}

export async function refreshAccessToken(
  options: RefreshAccessTokenOptions
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: options.clientId,
    refresh_token: options.refreshToken,
  });

  if (options.clientSecret) {
    body.set("client_secret", options.clientSecret);
  }

  if (options.scope) {
    body.set("scope", options.scope);
  }

  return await requestToken(options.metadata, body, "OAuth token refresh failed");
}

async function requestToken(
  metadata: OAuthMetadata,
  body: URLSearchParams,
  errorPrefix: string
): Promise<TokenResponse> {
  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${errorPrefix}: ${response.status} ${text}`);
  }

  return await response.json() as TokenResponse;
}

export async function getOAuthAuthorizationHeader(
  resourceUrl: string,
  providers: OAuthProvider<OAuthToken>[]
): Promise<string | undefined> {
  const url = new URL(resourceUrl);
  const provider = providers.find((candidate) => candidate.matches(url));
  if (!provider) {
    return undefined;
  }

  return await authorizeResource(resourceUrl, provider);
}

async function authorizeResource<TToken extends OAuthToken>(
  resourceUrl: string,
  provider: OAuthProvider<TToken>
): Promise<string> {
  const resource = provider.normalizeResource(resourceUrl);
  const metadata = await provider.fetchMetadata();
  const clientId = provider.getClientId();
  const clientSecret = provider.getClientSecret?.();
  const existing = await provider.loadToken(resource);

  if (existing && !provider.isTokenExpired(existing)) {
    return `Bearer ${existing.access_token}`;
  }

  if (existing?.refresh_token) {
    try {
      const refreshed = await provider.refreshToken({
        metadata,
        clientId,
        clientSecret,
        token: existing,
        resource,
      });
      await provider.saveToken(resource, refreshed);
      return `Bearer ${refreshed.access_token}`;
    } catch {
      // Fall through to interactive authorization.
    }
  }

  const { codeVerifier, codeChallenge } = createPkcePair();
  const state = createOAuthState();
  const callback = await startOAuthCallbackServer(state);
  const authorizeUrl = provider.buildAuthorizeUrl({
    metadata,
    clientId,
    redirectUri: callback.redirectUri,
    codeChallenge,
    state,
    resource,
  });

  console.log(`\n[AUTH] ${provider.name} authorization required`);
  console.log(`[AUTH] Open this URL in your browser:\n${authorizeUrl}\n`);
  try {
    openBrowser(authorizeUrl);
    console.log("[AUTH] Browser launch requested. Waiting for callback...");
  } catch {
    console.log("[AUTH] Browser launch failed. Open the URL manually.");
  }

  const code = await callback.waitForCode;
  const token = await provider.exchangeCode({
    metadata,
    clientId,
    clientSecret,
    code,
    codeVerifier,
    redirectUri: callback.redirectUri,
    resource,
  });

  await provider.saveToken(resource, token);
  console.log(`[AUTH] ${provider.name} OAuth completed and token saved.`);
  return `Bearer ${token.access_token}`;
}
