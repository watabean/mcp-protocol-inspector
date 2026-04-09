import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  exchangeAuthorizationCode,
  getExpiresAt,
  refreshAccessToken,
  type OAuthMetadata,
  type OAuthProvider,
  type TokenResponse,
} from "../oauth.js";

interface StoredToken extends TokenResponse {
  expires_at?: number;
  resource: string;
}

type TokenStore = Record<string, StoredToken>;

const STORE_PATH = join(homedir(), ".config", "mcp-inspector", "auth.json");
const ATLASSIAN_AUTH_SERVER = "https://auth.atlassian.com";
const ATLASSIAN_AUDIENCE = "api.atlassian.com";

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
  state: string
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
  const scopes = getRequestedScopes();
  if (scopes) {
    url.searchParams.set("scope", scopes);
  }
  return url.toString();
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

function normalizeResource(resourceUrl: string): string {
  return new URL(resourceUrl).toString();
}

async function loadToken(resource: string): Promise<StoredToken | undefined> {
  const store = await loadStore();
  return store[resource];
}

async function storeToken(resource: string, token: StoredToken): Promise<void> {
  const store = await loadStore();
  store[resource] = token;
  await saveStore(store);
}

function isTokenExpired(token: StoredToken): boolean {
  if (!token.expires_at) return false;
  return Date.now() >= token.expires_at - 60_000;
}

export const atlassianOAuthProvider: OAuthProvider<StoredToken> = {
  name: "Atlassian MCP",
  matches(url) {
    return url.hostname === "mcp.atlassian.com";
  },
  normalizeResource,
  loadToken,
  saveToken: storeToken,
  isTokenExpired,
  fetchMetadata,
  getClientId() {
    return requireEnv("ATLASSIAN_OAUTH_CLIENT_ID");
  },
  getClientSecret() {
    return requireEnv("ATLASSIAN_OAUTH_CLIENT_SECRET");
  },
  buildAuthorizeUrl({ metadata, clientId, redirectUri, codeChallenge, state }) {
    return buildAuthorizeUrl(metadata, clientId, redirectUri, codeChallenge, state);
  },
  async exchangeCode({ metadata, clientId, clientSecret, code, codeVerifier, redirectUri, resource }) {
    const token = await exchangeAuthorizationCode({
      metadata,
      clientId,
      clientSecret,
      code,
      codeVerifier,
      redirectUri,
    });
    return {
      ...token,
      resource,
      expires_at: getExpiresAt(token.expires_in),
    };
  },
  async refreshToken({ metadata, clientId, clientSecret, token }) {
    if (!token.refresh_token) {
      throw new Error("No refresh token available");
    }

    const refreshed = await refreshAccessToken({
      metadata,
      clientId,
      clientSecret,
      refreshToken: token.refresh_token,
      scope: getRequestedScopes(),
    });

    return {
      ...token,
      ...refreshed,
      resource: token.resource,
      expires_at: getExpiresAt(refreshed.expires_in),
    };
  },
};
