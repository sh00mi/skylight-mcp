import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkylightClient } from "../src/api/client.js";
import { loadTokens, saveTokens } from "../src/api/oauth.js";
import type { Config } from "../src/config.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function tokenResponse(access: string, refresh: string): Response {
  return jsonResponse(200, {
    access_token: access,
    token_type: "Bearer",
    expires_in: 86400,
    refresh_token: refresh,
    created_at: Math.floor(Date.now() / 1000),
  });
}

const userResponse = () => jsonResponse(200, { data: { id: "1", attributes: { subscription_status: "plus" } } });
const framesResponse = (ids: string[]) =>
  jsonResponse(200, { data: ids.map((id) => ({ id, attributes: { name: `frame ${id}` } })) });

describe("SkylightClient with OAuth refresh tokens", () => {
  const fetchMock = vi.fn();
  let dir: string;
  let tokenFile: string;

  function makeClient(overrides: Partial<Config> = {}): SkylightClient {
    return new SkylightClient({
      tokenFile,
      authType: "bearer",
      timezone: "America/New_York",
      ...overrides,
    } as Config);
  }

  function requestsTo(path: string) {
    return fetchMock.mock.calls.filter(([url]) => String(url).includes(path));
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skylight-client-"));
    tokenFile = join(dir, "tokens.json");
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchMock.mockReset();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refreshes, saves rotated tokens, detects Plus and discovers the frame", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/oauth/token")) return tokenResponse("access-1", "refresh-2");
      if (url.endsWith("/api/user")) return userResponse();
      if (url.endsWith("/api/frames")) return framesResponse(["42"]);
      throw new Error(`unexpected ${url}`);
    });

    const client = makeClient({ refreshToken: "refresh-1" });
    await client.initialize();

    expect(client.hasPlus()).toBe(true);
    expect(client.frameId).toBe("42");
    expect(loadTokens(tokenFile)?.refreshToken).toBe("refresh-2");
    const [, init] = requestsTo("/api/user")[0];
    expect(init.headers.Authorization).toBe("Bearer access-1");
  });

  it("reuses an unexpired saved access token without refreshing", async () => {
    saveTokens(tokenFile, { accessToken: "saved", refreshToken: "r", expiresAt: Date.now() / 1000 + 3600 });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/user")) return userResponse();
      throw new Error(`unexpected ${url}`);
    });

    const client = makeClient({ frameId: "7" });
    await client.initialize();

    expect(requestsTo("/oauth/token")).toHaveLength(0);
    expect(client.frameId).toBe("7");
  });

  it("uses a token another process saved after its refresh token was rotated away", async () => {
    saveTokens(tokenFile, { accessToken: "stale", refreshToken: "rotated-away", expiresAt: 0 });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/oauth/token")) {
        // Meanwhile another process refreshed and wrote new tokens
        saveTokens(tokenFile, {
          accessToken: "from-other-process",
          refreshToken: "refresh-new",
          expiresAt: Date.now() / 1000 + 3600,
        });
        return jsonResponse(400, { error: "invalid_grant" });
      }
      if (url.endsWith("/api/user")) return userResponse();
      throw new Error(`unexpected ${url}`);
    });

    const client = makeClient({ frameId: "7" });
    await client.initialize();

    expect(requestsTo("/oauth/token")).toHaveLength(1);
    const [, init] = requestsTo("/api/user")[0];
    expect(init.headers.Authorization).toBe("Bearer from-other-process");
  });

  it("falls back to SKYLIGHT_REFRESH_TOKEN when the saved one is rejected", async () => {
    saveTokens(tokenFile, { accessToken: "stale", refreshToken: "revoked", expiresAt: 0 });
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes("/oauth/token")) {
        const body = new URLSearchParams(String(init.body));
        return body.get("refresh_token") === "env-token"
          ? tokenResponse("access-env", "refresh-env-2")
          : jsonResponse(400, { error: "invalid_grant" });
      }
      if (url.endsWith("/api/user")) return userResponse();
      throw new Error(`unexpected ${url}`);
    });

    const client = makeClient({ frameId: "7", refreshToken: "env-token" });
    await client.initialize();

    expect(requestsTo("/oauth/token")).toHaveLength(2);
    expect(loadTokens(tokenFile)?.refreshToken).toBe("refresh-env-2");
  });

  it("tells the user to log in again when every refresh token is rejected", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { error: "invalid_grant" }));
    const client = makeClient({ refreshToken: "revoked" });
    await expect(client.initialize()).rejects.toThrow(/skylight-mcp login/);
  });

  it("refreshes and retries once when a request gets a 401", async () => {
    saveTokens(tokenFile, { accessToken: "revoked-access", refreshToken: "r1", expiresAt: Date.now() / 1000 + 3600 });
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes("/oauth/token")) return tokenResponse("access-2", "r2");
      const auth = (init.headers as Record<string, string>).Authorization;
      if (auth === "Bearer revoked-access") return jsonResponse(401, {});
      return userResponse();
    });

    const client = makeClient({ frameId: "7" });
    await client.initialize();

    expect(requestsTo("/oauth/token")).toHaveLength(1);
    expect(client.hasPlus()).toBe(true);
  });

  it("asks for SKYLIGHT_FRAME_ID when the account has several frames", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/oauth/token")) return tokenResponse("a", "r");
      if (url.endsWith("/api/user")) return userResponse();
      return framesResponse(["1", "2"]);
    });

    const client = makeClient({ refreshToken: "r0" });
    await expect(client.initialize()).rejects.toThrow(/SKYLIGHT_FRAME_ID.*1 \(frame 1\), 2 \(frame 2\)/);
  });
});
