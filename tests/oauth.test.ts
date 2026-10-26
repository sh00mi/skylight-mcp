import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OAuthError,
  buildAuthorizeUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  isExpired,
  loadTokens,
  parseAuthorizationRedirect,
  refreshAccessToken,
  saveTokens,
} from "../src/api/oauth.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("oauth", () => {
  describe("createPkcePair", () => {
    it("derives an S256 challenge from a base64url verifier", () => {
      const { verifier, challenge } = createPkcePair();
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
      const expected = createHash("sha256").update(verifier).digest("base64url");
      expect(challenge).toBe(expected);
    });
  });

  describe("buildAuthorizeUrl", () => {
    it("includes the PKCE challenge, client and redirect", () => {
      const url = new URL(buildAuthorizeUrl("challenge123", "state456"));
      expect(url.origin + url.pathname).toBe("https://app.ourskylight.com/oauth/authorize");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("client_id")).toBe("skylight-mobile");
      expect(url.searchParams.get("redirect_uri")).toBe("https://ourskylight.com/welcome");
      expect(url.searchParams.get("code_challenge")).toBe("challenge123");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("state")).toBe("state456");
    });
  });

  describe("parseAuthorizationRedirect", () => {
    it("extracts the code from a full redirect URL", () => {
      expect(parseAuthorizationRedirect("https://ourskylight.com/welcome?code=abc&state=s1", "s1")).toBe("abc");
    });

    it("accepts a bare query string", () => {
      expect(parseAuthorizationRedirect("  code=abc&state=s1  ", "s1")).toBe("abc");
    });

    it("rejects a mismatched state", () => {
      expect(() => parseAuthorizationRedirect("https://x/?code=abc&state=other", "s1")).toThrow(/State mismatch/);
    });

    it("reports an OAuth error", () => {
      expect(() =>
        parseAuthorizationRedirect("https://x/?error=access_denied&error_description=Denied", "s1")
      ).toThrow(/Denied/);
    });

    it("rejects input without a code", () => {
      expect(() => parseAuthorizationRedirect("https://ourskylight.com/welcome", "s1")).toThrow(/No authorization code/);
    });
  });

  describe("isExpired", () => {
    it("treats tokens within a minute of expiry as expired", () => {
      const tokens = { accessToken: "a", refreshToken: "r", expiresAt: 1000 };
      expect(isExpired(tokens, 900)).toBe(false);
      expect(isExpired(tokens, 950)).toBe(true);
    });
  });

  describe("token requests", () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
      vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      fetchMock.mockReset();
    });

    it("refreshes with a form-encoded refresh_token grant", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          access_token: "new-access",
          token_type: "Bearer",
          expires_in: 86400,
          refresh_token: "new-refresh",
          created_at: 1000,
        })
      );

      const tokens = await refreshAccessToken("old-refresh");

      expect(tokens).toEqual({ accessToken: "new-access", refreshToken: "new-refresh", expiresAt: 87400 });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://app.ourskylight.com/oauth/token");
      expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      expect(init.headers["Skylight-Api-Version"]).toBeDefined();
      const body = new URLSearchParams(init.body);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("old-refresh");
      expect(body.get("client_id")).toBe("skylight-mobile");
    });

    it("keeps the old refresh token when none is returned", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { access_token: "a", token_type: "Bearer", expires_in: 60, created_at: 0 })
      );
      const tokens = await refreshAccessToken("old-refresh");
      expect(tokens.refreshToken).toBe("old-refresh");
    });

    it("flags invalid_grant errors", async () => {
      fetchMock.mockResolvedValue(jsonResponse(400, { error: "invalid_grant" }));
      const error = await refreshAccessToken("bad").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OAuthError);
      expect((error as OAuthError).invalidGrant).toBe(true);
      expect((error as OAuthError).status).toBe(400);
    });

    it("exchanges an authorization code with the PKCE verifier", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { access_token: "a", token_type: "Bearer", expires_in: 60, refresh_token: "r" })
      );

      await exchangeAuthorizationCode("the-code", "the-verifier");

      const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("the-code");
      expect(body.get("code_verifier")).toBe("the-verifier");
      expect(body.get("redirect_uri")).toBe("https://ourskylight.com/welcome");
    });
  });

  describe("token storage", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "skylight-oauth-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("round-trips tokens, creating the directory", () => {
      const file = join(dir, "nested", "tokens.json");
      const tokens = { accessToken: "a", refreshToken: "r", expiresAt: 123 };
      saveTokens(file, tokens);
      expect(loadTokens(file)).toEqual(tokens);
    });

    it("returns null for a missing or invalid file", () => {
      expect(loadTokens(join(dir, "missing.json"))).toBeNull();
      const file = join(dir, "bad.json");
      saveTokens(file, { accessToken: "a", refreshToken: "", expiresAt: 0 });
      expect(loadTokens(file)).toBeNull();
      expect(readFileSync(file, "utf8")).toContain("accessToken");
    });
  });
});
