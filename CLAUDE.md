# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

MCP server enabling AI assistants to interact with the Skylight family calendar API (calendar, chores, lists, tasks, rewards, meals, photos).

Base API URL: `https://app.ourskylight.com`

## Commands

```bash
npm install
npm run build          # Compile TypeScript
npm run dev            # Development with hot reload (tsx watch)
npm test               # Run vitest tests
npm test -- dates      # Run single test file (matches filename)
npm run test:coverage  # Tests with coverage
npm run lint           # ESLint
npm run typecheck      # tsc --noEmit
npm run generate:types # Generate TypeScript types from OpenAPI spec
```

## Architecture

**Two-tier tool system**:
1. `api/endpoints/*.ts` (11 modules) - Low-level HTTP wrappers for each API resource
2. `tools/*.ts` (9 modules) - MCP tool definitions with Zod parameter validation

**Tool Registration**: Each domain exports `registerXxxTools(server)` called from `server.ts`. Plus-only tools are conditionally registered based on subscription status.

**Key files**:
- `config.ts` - Zod-validated env config supporting two auth methods
- `api/client.ts` - HTTP client with Bearer/Basic auth, auto-login, subscription status tracking
- `api/auth.ts` - Login endpoint for email/password authentication
- `api/generated-types.ts` - Auto-generated types from OpenAPI spec
- `utils/dates.ts` - Parses "today", "tomorrow", day names, YYYY-MM-DD

## Authentication

Three methods supported (validated via Zod refinement in `config.ts`):

1. **OAuth** (recommended): `skylight-mcp login` (`src/login.ts`) runs the authorization code + PKCE flow (`client_id=skylight-mobile`, redirect `https://ourskylight.com/welcome`; the user pastes the redirect URL back) and saves tokens to `SKYLIGHT_TOKEN_FILE` (default `~/.skylight-mcp/tokens.json`). The client (`api/oauth.ts`, `api/client.ts`) refreshes via `POST /oauth/token` with `grant_type=refresh_token` and sends `Bearer <access_token>`. `SKYLIGHT_REFRESH_TOKEN` is an alternative seed. Takes precedence when a refresh token or token file exists. Subscription status comes from `GET /api/user`; the frame from `GET /api/frames` when `SKYLIGHT_FRAME_ID` is unset.
2. **Email/Password** (legacy): POST /api/sessions, then `Basic base64(userId:token)`. Skylight now rejects this login with "This version of Skylight is no longer supported".
3. **Manual Token**: Set `SKYLIGHT_TOKEN` and optionally `SKYLIGHT_AUTH_TYPE` (bearer/basic).

Options 2 and 3 require `SKYLIGHT_FRAME_ID` (household identifier from API URLs like `/api/frames/{frameId}/chores`).

All requests send `Skylight-Api-Version` (`SKYLIGHT_API_VERSION`, default `2026-10-15`).

## Plus Subscription

Some features require a Skylight Plus subscription. The server detects subscription status from `GET /api/user` (OAuth) or the login response (email/password), `subscription_status: "plus"`; `SKYLIGHT_SUBSCRIPTION` overrides it. Plus-only tools are not registered for non-Plus users.

**Plus-only domains**: Rewards, Meals, Photos

## MCP Tools (35+ total)

### Base Tools (Always Available)

| Category | Tools |
|----------|-------|
| Calendar | `get_calendar_events`, `get_source_calendars`, `create_calendar_event`, `update_calendar_event`, `delete_calendar_event` |
| Chores | `get_chores`, `create_chore`, `update_chore`, `delete_chore` |
| Lists | `get_lists`, `get_list_items`, `create_list`, `update_list`, `delete_list`, `create_list_item`, `update_list_item`, `delete_list_item` |
| Tasks | `create_task` |
| Family | `get_family_members`, `get_frame_info`, `get_devices` |
| Misc | `get_avatars`, `get_colors` |

### Plus-Only Tools

| Category | Tools |
|----------|-------|
| Rewards | `get_rewards`, `get_reward_points`, `create_reward`, `update_reward`, `delete_reward`, `redeem_reward`, `unredeem_reward` |
| Meals | `get_meal_categories`, `get_recipes`, `get_recipe`, `create_recipe`, `update_recipe`, `delete_recipe`, `add_recipe_to_grocery_list`, `get_meal_sittings`, `create_meal_sitting` |
| Photos | `get_albums` |

## Technical Details

- **Runtime**: Node.js 18+
- **Module System**: ESM (`"type": "module"`)
- **TypeScript**: ES2022 target, NodeNext module resolution, strict mode
- **API Format**: JSON:API patterns (type, id, attributes, relationships)
- **Timezone**: Defaults to America/New_York, configurable via `SKYLIGHT_TIMEZONE`
- **Type Generation**: Uses `openapi-typescript` to generate types from `skylight-api` OpenAPI spec

## Versioning & Releases

**Release Process**:
1. Update version in `package.json`
2. Update `CHANGELOG.md` with changes
3. Commit changes and merge to main
4. Create and push a tag with `v` prefix: `git tag v1.2.3 && git push origin v1.2.3`

**Important**: Tags must start with `v` (e.g., `v1.1.7`) to trigger the release workflow. Tags without the `v` prefix (e.g., `1.1.7`) will not trigger a release.

The release workflow (`.github/workflows/release.yml`) will:
- Run linting, type checking, and tests
- Build the package
- Publish to npm with provenance
- Create a GitHub release with auto-generated changelog

## API Quirks

- **Calendar date_max is exclusive**: When querying calendar events, `date_max` is treated as exclusive. The code adds 1 day to include events on the end date.
- **Auth format**: Session tokens from the legacy `/api/sessions` login use `Basic base64(userId:token)`; OAuth access tokens use `Bearer`.
- **Refresh token rotation**: `/oauth/token` returns a new refresh token on every refresh and the old one stops working, so it must be saved each time. The token file is re-read before each refresh because several processes may share it.
- **API version header**: Requests without a supported `Skylight-Api-Version` are rejected with "This version of Skylight is no longer supported".
