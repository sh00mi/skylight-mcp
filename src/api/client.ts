import { getConfig, usesEmailAuth, usesRefreshAuth, type Config } from "../config.js";
import { API_VERSION, login } from "./auth.js";
import {
  isExpired,
  loadTokens,
  OAuthError,
  refreshAccessToken,
  saveTokens,
  type OAuthTokens,
} from "./oauth.js";
import {
  AuthenticationError,
  ConfigurationError,
  NotFoundError,
  RateLimitError,
  SkylightError,
} from "../utils/errors.js";

const BASE_URL = "https://app.ourskylight.com";

/**
 * Skylight subscription status types
 */
export type SubscriptionStatus = "plus" | "free" | "trial" | null;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  params?: Record<string, string | boolean | number | undefined>;
  body?: unknown;
}

/**
 * Skylight API Client
 * Handles authentication and HTTP requests to the Skylight API
 */
export class SkylightClient {
  private config: Config;
  private resolvedToken: string | null = null;
  private resolvedUserId: string | null = null;
  private loginPromise: Promise<{ token: string; userId: string }> | null = null;
  private subscriptionStatus: SubscriptionStatus = null;
  private oauthTokens: OAuthTokens | null = null;
  private refreshPromise: Promise<string> | null = null;
  private discoveredFrameId: string | null = null;

  constructor(config?: Config) {
    this.config = config ?? getConfig();
  }

  /**
   * Get the authentication credentials
   * If using refresh token or email/password auth, will obtain a token first
   */
  private async getCredentials(): Promise<{ token: string; userId: string | null }> {
    // OAuth access tokens expire, so check them before reusing
    if (usesRefreshAuth(this.config)) {
      if (this.oauthTokens && !isExpired(this.oauthTokens)) {
        return { token: this.oauthTokens.accessToken, userId: null };
      }
      // Share one refresh between concurrent requests
      this.refreshPromise ??= this.performRefresh().finally(() => {
        this.refreshPromise = null;
      });
      return { token: await this.refreshPromise, userId: null };
    }

    // If we already have a resolved token, use it
    if (this.resolvedToken) {
      return { token: this.resolvedToken, userId: this.resolvedUserId };
    }

    // If using token-based auth, use the configured token
    if (!usesEmailAuth(this.config)) {
      return { token: this.config.token!, userId: null };
    }

    // If already logging in, wait for that to complete
    if (this.loginPromise) {
      const result = await this.loginPromise;
      return { token: result.token, userId: result.userId };
    }

    // Login with email/password
    this.loginPromise = this.performLogin();
    try {
      const result = await this.loginPromise;
      this.resolvedToken = result.token;
      this.resolvedUserId = result.userId;
      return result;
    } finally {
      this.loginPromise = null;
    }
  }

  /**
   * Perform login and return token and userId
   */
  private async performLogin(): Promise<{ token: string; userId: string }> {
    const { email, password } = this.config;
    if (!email || !password) {
      throw new AuthenticationError("Email and password are required for login");
    }

    console.error("Logging in to Skylight...");
    const result = await login(email, password);
    this.subscriptionStatus = result.subscriptionStatus as SubscriptionStatus;
    console.error(`Logged in as ${result.email} (${result.subscriptionStatus})`);
    return { token: result.token, userId: result.userId };
  }

  /**
   * Get a fresh OAuth access token
   *
   * The token file may be shared with other server processes, and Skylight rotates
   * refresh tokens, so the file is re-read on every attempt: another process may
   * already have refreshed, or rotated the refresh token we were about to use.
   * SKYLIGHT_REFRESH_TOKEN is the last resort.
   */
  private async performRefresh(): Promise<string> {
    const rejectedAccessToken = this.oauthTokens?.accessToken;
    const tried = new Set<string>();
    let lastError: unknown = new Error("No refresh token available");

    for (let attempt = 0; attempt < 3; attempt++) {
      const saved = loadTokens(this.config.tokenFile);
      if (saved && saved.accessToken !== rejectedAccessToken && !isExpired(saved)) {
        this.oauthTokens = saved;
        return saved.accessToken;
      }

      const refreshToken = [saved?.refreshToken, this.config.refreshToken].find(
        (token): token is string => !!token && !tried.has(token)
      );
      if (!refreshToken) {
        break;
      }
      tried.add(refreshToken);

      try {
        const tokens = await refreshAccessToken(refreshToken);
        saveTokens(this.config.tokenFile, tokens);
        this.oauthTokens = tokens;
        return tokens.accessToken;
      } catch (error) {
        lastError = error;
        // Only a rejected refresh token is worth retrying with another one
        if (!(error instanceof OAuthError && error.invalidGrant)) {
          break;
        }
      }
    }

    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new AuthenticationError(`${reason}. Run \`npx @eaglebyte/skylight-mcp login\` to sign in again.`);
  }

  /**
   * Read the account's subscription status from /api/user
   */
  private async fetchSubscriptionStatus(): Promise<SubscriptionStatus> {
    const response = await this.get<{ data: { attributes: { subscription_status?: string | null } } }>(
      "/api/user"
    );
    const status = response.data.attributes.subscription_status;
    return status === "plus" || status === "trial" ? status : "free";
  }

  /**
   * Find the account's frame when SKYLIGHT_FRAME_ID is not set
   */
  private async discoverFrameId(): Promise<string> {
    const response = await this.get<{ data: Array<{ id: string; attributes: { name?: string } }> }>(
      "/api/frames"
    );
    const frames = response.data;

    if (frames.length === 1) {
      console.error(`Using frame ${frames[0].id} (${frames[0].attributes.name ?? "unnamed"})`);
      return frames[0].id;
    }
    if (frames.length === 0) {
      throw new ConfigurationError("This Skylight account has no frames.");
    }
    const list = frames.map((frame) => `${frame.id} (${frame.attributes.name ?? "unnamed"})`).join(", ");
    throw new ConfigurationError(`This account has several frames; set SKYLIGHT_FRAME_ID to one of: ${list}`);
  }

  /**
   * Build the Authorization header
   * For email/password auth: Basic base64(userId:token)
   * For manual token auth: Bearer or Basic based on config
   */
  private async getAuthHeader(): Promise<string> {
    const { token, userId } = await this.getCredentials();

    // If using email/password auth, use Basic auth with userId:token
    if (usesEmailAuth(this.config) && userId) {
      const credentials = Buffer.from(`${userId}:${token}`).toString("base64");
      return `Basic ${credentials}`;
    }

    // For manual token config, respect the authType setting (OAuth tokens are always Bearer)
    if (this.config.authType === "basic" && !usesRefreshAuth(this.config)) {
      return `Basic ${token}`;
    }
    return `Bearer ${token}`;
  }

  /**
   * Build URL with query parameters
   */
  private buildUrl(endpoint: string, params?: Record<string, string | boolean | number | undefined>): string {
    const url = new URL(endpoint, BASE_URL);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url.toString();
  }

  /**
   * Handle API response errors
   */
  private async handleResponseError(response: Response, url: string): Promise<never> {
    const status = response.status;

    if (status === 401) {
      // Clear cached credentials on auth failure
      this.resolvedToken = null;
      this.resolvedUserId = null;
      console.error(`[client] 401 Unauthorized for ${url}`);

      if (usesEmailAuth(this.config)) {
        throw new AuthenticationError(
          "API request returned 401. This may indicate your frame ID is incorrect or doesn't belong to this account. " +
            "Please verify your SKYLIGHT_FRAME_ID environment variable."
        );
      }
      throw new AuthenticationError();
    }

    if (status === 404) {
      throw new NotFoundError("Resource");
    }

    if (status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      throw new RateLimitError(retryAfter ? parseInt(retryAfter, 10) : undefined);
    }

    // Try to get error details from response
    let errorMessage = `HTTP ${status}`;
    try {
      const errorBody = await response.text();
      if (errorBody) {
        errorMessage += `: ${errorBody.slice(0, 200)}`;
      }
    } catch {
      // Ignore parse errors
    }

    throw new SkylightError(errorMessage, "HTTP_ERROR", status, status >= 500);
  }

  /**
   * Make an authenticated request to the Skylight API
   */
  async request<T>(endpoint: string, options: RequestOptions = {}, isRetry = false): Promise<T> {
    const { method = "GET", params, body } = options;

    // Replace {frameId} placeholder with actual frame ID
    const resolvedEndpoint = endpoint.includes("{frameId}") ? endpoint.replace("{frameId}", this.frameId) : endpoint;
    const url = this.buildUrl(resolvedEndpoint, params);

    console.error(`[client] ${method} ${url}`);

    const headers: Record<string, string> = {
      Authorization: await this.getAuthHeader(),
      Accept: "application/json",
      "Skylight-Api-Version": API_VERSION,
    };

    if (body) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    console.error(`[client] Response: ${response.status}`);

    if (!response.ok) {
      // For email/password or refresh token auth, try re-login once on 401
      const canReauth = usesEmailAuth(this.config) || usesRefreshAuth(this.config);
      if (response.status === 401 && canReauth && !isRetry) {
        console.error("[client] Got 401, attempting re-login...");
        this.resolvedToken = null;
        this.resolvedUserId = null;
        if (this.oauthTokens) {
          this.oauthTokens.expiresAt = 0;
        }
        return this.request<T>(endpoint, options, true);
      }
      await this.handleResponseError(response, url);
    }

    // Handle 304 Not Modified
    if (response.status === 304) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  /**
   * GET request helper
   */
  async get<T>(endpoint: string, params?: Record<string, string | boolean | number | undefined>): Promise<T> {
    return this.request<T>(endpoint, { method: "GET", params });
  }

  /**
   * POST request helper
   */
  async post<T>(endpoint: string, body: unknown): Promise<T> {
    return this.request<T>(endpoint, { method: "POST", body });
  }

  /**
   * Get the frame ID from config, or the one discovered during initialize()
   */
  get frameId(): string {
    const frameId = this.config.frameId ?? this.discoveredFrameId;
    if (!frameId) {
      throw new ConfigurationError("SKYLIGHT_FRAME_ID is not set and no frame has been discovered");
    }
    return frameId;
  }

  /**
   * Get the timezone from config
   */
  get timezone(): string {
    return this.config.timezone;
  }

  /**
   * Check if user has Plus subscription
   */
  hasPlus(): boolean {
    return this.subscriptionStatus === "plus";
  }

  /**
   * Get the subscription status
   */
  getSubscriptionStatus(): SubscriptionStatus {
    return this.subscriptionStatus;
  }

  /**
   * Initialize the client (triggers login if using email/password or refresh token auth)
   * With refresh token auth, also resolves the subscription status and frame
   */
  async initialize(): Promise<void> {
    await this.getCredentials();

    if (usesRefreshAuth(this.config)) {
      this.subscriptionStatus = this.config.subscription ?? (await this.fetchSubscriptionStatus());
      if (!this.config.frameId) {
        this.discoveredFrameId = await this.discoverFrameId();
      }
      console.error(`Authenticated via OAuth (${this.subscriptionStatus})`);
    }
  }
}

// Singleton instance
let clientInstance: SkylightClient | null = null;

export function getClient(): SkylightClient {
  if (!clientInstance) {
    clientInstance = new SkylightClient();
  }
  return clientInstance;
}

/**
 * Initialize the client singleton and return it
 * This triggers login if using email/password auth
 */
export async function initializeClient(): Promise<SkylightClient> {
  const client = getClient();
  await client.initialize();
  return client;
}
