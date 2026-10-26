/**
 * Skylight OAuth
 * Skylight's apps sign in with OAuth 2.0 authorization code + PKCE against /oauth/token.
 * The server only needs a refresh token; `skylight-mcp login` obtains the first one.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { API_VERSION } from "./auth.js";

const BASE_URL = "https://app.ourskylight.com";

// OAuth client and redirect the Skylight web app uses
export const OAUTH_CLIENT_ID = "skylight-mobile";
export const OAUTH_REDIRECT_URI = "https://ourskylight.com/welcome";
export const OAUTH_SCOPE = "everything";

// Refresh this many seconds before the access token actually expires
const EXPIRY_SKEW_SECONDS = 60;

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch seconds after which the access token is expired */
  expiresAt: number;
}

interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  created_at?: number;
}

/**
 * Error from /oauth/token; `invalidGrant` means the code or refresh token was rejected
 */
export class OAuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly invalidGrant: boolean
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

/**
 * POST form parameters to /oauth/token and convert the response to OAuthTokens
 */
async function requestToken(params: Record<string, string>, fallbackRefreshToken?: string): Promise<OAuthTokens> {
  const response = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "Skylight-Api-Version": API_VERSION,
    },
    body: new URLSearchParams({ client_id: OAUTH_CLIENT_ID, ...params }).toString(),
  });

  console.error(`[oauth] ${params.grant_type} response status: ${response.status}`);

  if (!response.ok) {
    let errorBody = "";
    try {
      errorBody = await response.text();
    } catch {
      // ignore
    }
    throw new OAuthError(
      `OAuth token request failed: HTTP ${response.status}${errorBody ? ` - ${errorBody.slice(0, 200)}` : ""}`,
      response.status,
      errorBody.includes("invalid_grant")
    );
  }

  const data = (await response.json()) as OAuthTokenResponse;
  const refreshToken = data.refresh_token ?? fallbackRefreshToken;
  if (!refreshToken) {
    throw new OAuthError("OAuth token response did not include a refresh token", response.status, false);
  }

  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt: (data.created_at ?? Math.floor(Date.now() / 1000)) + data.expires_in,
  };
}

/**
 * Exchange a refresh token for new tokens
 * Skylight rotates the refresh token, so callers must persist the returned one
 */
export function refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
  return requestToken({ grant_type: "refresh_token", refresh_token: refreshToken }, refreshToken);
}

/**
 * Exchange an authorization code from the sign-in redirect for tokens
 */
export function exchangeAuthorizationCode(code: string, codeVerifier: string): Promise<OAuthTokens> {
  return requestToken({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPE,
  });
}

/**
 * Check whether the access token is expired (or about to be)
 */
export function isExpired(tokens: OAuthTokens, nowSeconds = Date.now() / 1000): boolean {
  return nowSeconds > tokens.expiresAt - EXPIRY_SKEW_SECONDS;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Create a PKCE code verifier and its S256 challenge (RFC 7636)
 */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(64));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Create a random state value to match the redirect against the request
 */
export function createState(): string {
  return base64Url(randomBytes(16));
}

/**
 * Build the URL where the user signs in to Skylight
 */
export function buildAuthorizeUrl(codeChallenge: string, state: string): string {
  const url = new URL("/oauth/authorize", BASE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  }).toString();
  return url.toString();
}

/**
 * Get the authorization code from the redirect URL the user pastes back
 * Accepts the full URL or just the query string; verifies the state
 */
export function parseAuthorizationRedirect(input: string, expectedState: string): string {
  const trimmed = input.trim();
  const query = trimmed.includes("?") ? trimmed.slice(trimmed.indexOf("?") + 1) : trimmed;
  const params = new URLSearchParams(query.split("#")[0]);

  const error = params.get("error");
  if (error) {
    throw new Error(`Sign-in failed: ${params.get("error_description") ?? error}`);
  }

  const code = params.get("code");
  if (!code) {
    throw new Error("No authorization code found. Paste the full address from the browser after signing in.");
  }

  const state = params.get("state");
  if (state !== null && state !== expectedState) {
    throw new Error("State mismatch: that address is from a different sign-in attempt. Run login again.");
  }

  return code;
}

/**
 * Read saved OAuth tokens, or null if the file is missing or unreadable
 */
export function loadTokens(tokenFile: string): OAuthTokens | null {
  try {
    const data = JSON.parse(readFileSync(tokenFile, "utf8")) as OAuthTokens;
    return data.refreshToken ? data : null;
  } catch {
    return null;
  }
}

/**
 * Save OAuth tokens so a rotated refresh token survives restarts
 */
export function saveTokens(tokenFile: string, tokens: OAuthTokens): void {
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}
