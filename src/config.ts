import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// Config schema supports three auth methods:
// 1. OAuth refresh token (preferred) - exchanged at /oauth/token for access tokens
// 2. Email/password (legacy) - the old /api/sessions login, now rejected by Skylight
// 3. Token-based (legacy) - for manual token capture
const ConfigSchema = z
  .object({
    // OAuth refresh token auth (preferred)
    refreshToken: z.string().min(1).optional(),
    tokenFile: z.string().min(1),
    // Overrides the subscription status that is otherwise read from /api/user
    subscription: z.enum(["plus", "free", "trial"]).optional(),

    // Email/password auth (legacy)
    email: z.string().email().optional(),
    password: z.string().min(1).optional(),

    // Token-based auth (legacy)
    token: z.string().min(1).optional(),
    authType: z.enum(["bearer", "basic"]).default("bearer"),

    // Required, except with refresh token auth, which can discover it from /api/frames
    frameId: z.string().min(1).optional(),

    // Optional
    timezone: z.string().default("America/New_York"),
  })
  .refine(
    (data) => {
      // Must have a refresh token (env or saved file), email+password, OR token
      const hasRefreshAuth = !!data.refreshToken || existsSync(data.tokenFile);
      const hasEmailAuth = data.email && data.password;
      const hasTokenAuth = !!data.token;
      return hasRefreshAuth || hasEmailAuth || hasTokenAuth;
    },
    {
      message:
        "Run `npx @eaglebyte/skylight-mcp login`, or set SKYLIGHT_REFRESH_TOKEN, SKYLIGHT_EMAIL and SKYLIGHT_PASSWORD, or SKYLIGHT_TOKEN",
    }
  )
  .refine((data) => !!data.frameId || !!data.refreshToken || existsSync(data.tokenFile), {
    message: "SKYLIGHT_FRAME_ID is required",
  });

/**
 * Where OAuth tokens are saved, from SKYLIGHT_TOKEN_FILE or ~/.skylight-mcp/tokens.json
 */
export function getTokenFile(): string {
  return process.env.SKYLIGHT_TOKEN_FILE || join(homedir(), ".skylight-mcp", "tokens.json");
}

export type Config = z.infer<typeof ConfigSchema>;

export interface ResolvedConfig {
  token: string;
  frameId: string;
  timezone: string;
  authType: "bearer" | "basic";
}

export function loadConfig(): Config {
  const result = ConfigSchema.safeParse({
    email: process.env.SKYLIGHT_EMAIL,
    password: process.env.SKYLIGHT_PASSWORD,
    refreshToken: process.env.SKYLIGHT_REFRESH_TOKEN,
    tokenFile: getTokenFile(),
    subscription: process.env.SKYLIGHT_SUBSCRIPTION || undefined,
    token: process.env.SKYLIGHT_TOKEN,
    frameId: process.env.SKYLIGHT_FRAME_ID,
    authType: process.env.SKYLIGHT_AUTH_TYPE || "bearer",
    timezone: process.env.SKYLIGHT_TIMEZONE || "America/New_York",
  });

  if (!result.success) {
    const errors = result.error.errors.map((e) => `  - ${e.message}`).join("\n");
    console.error(`
Skylight MCP Server - Configuration Error

Missing or invalid configuration:
${errors}

Authentication (choose one):
  Option 1 - OAuth (recommended):
    Run \`npx @eaglebyte/skylight-mcp login\` once to sign in and save tokens.
    SKYLIGHT_REFRESH_TOKEN - Or provide a refresh token directly
    SKYLIGHT_TOKEN_FILE    - Where tokens are saved (default: ~/.skylight-mcp/tokens.json)

  Option 2 - Email/Password (legacy, rejected by the current Skylight API):
    SKYLIGHT_EMAIL    - Your Skylight account email
    SKYLIGHT_PASSWORD - Your Skylight account password

  Option 3 - Manual Token:
    SKYLIGHT_TOKEN    - Your Skylight API token
    SKYLIGHT_AUTH_TYPE - 'bearer' or 'basic' (default: bearer)

Frame:
  SKYLIGHT_FRAME_ID - Your frame/household ID (required for options 2 and 3;
                      with OAuth it is discovered when the account has one frame)

Optional:
  SKYLIGHT_TIMEZONE     - Timezone for dates (default: America/New_York)
  SKYLIGHT_SUBSCRIPTION - plus, free or trial (OAuth reads it from your account by default)
  SKYLIGHT_API_VERSION  - Skylight-Api-Version header (default: 2026-10-15)
`);
    process.exit(1);
  }

  return result.data;
}

let cachedConfig: Config | null = null;

export function getConfig(): Config {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

/**
 * Check if config uses email/password auth
 */
export function usesEmailAuth(config: Config): boolean {
  return !usesRefreshAuth(config) && !!(config.email && config.password);
}

/**
 * Check if config uses OAuth refresh token auth (takes precedence over the others)
 */
export function usesRefreshAuth(config: Config): boolean {
  return !!config.refreshToken || existsSync(config.tokenFile);
}
