# Skylight MCP Server

An MCP (Model Context Protocol) server for the Skylight Calendar API. Enables AI assistants like Claude to interact with your Skylight family calendar, chores, lists, and more.

## Features

- **Calendar**: Query calendar events ("What's on my calendar today?")
- **Chores**: View and create chores ("Add emptying dishwasher to chores")
- **Lists**: View grocery and to-do lists ("What's on the grocery list?")
- **Tasks**: Add items to the task box ("Add XYZ to my task list")
- **Family**: View family members and devices
- **Rewards**: Check reward points and available rewards

## Quick Start

### Installation

#### 1. Sign in once

Skylight signs in with OAuth, so the server needs a saved token rather than your password:

```bash
npx @eaglebyte/skylight-mcp login
```

It prints a sign-in address and walks you through it:

1. Open a new browser tab and its developer tools (F12), go to the **Network** tab, tick **Preserve log** and filter for `welcome`.
2. Open the printed address in that tab and sign in to Skylight.
3. Copy the URL of the `welcome?code=...` request from the Network tab and paste it into the terminal.

The developer tools step is needed because Skylight only redirects to its own `ourskylight.com/welcome` page, which immediately removes the code from the address bar and history (it rejects loopback and out-of-band redirect URIs). Tokens are saved to `~/.skylight-mcp/tokens.json` and refreshed automatically from then on, so you only do this once.

#### 2. Add the server

**mcp.json:**
```json
{
  "mcpServers": {
    "skylight": {
      "command": "npx",
      "args": ["@eaglebyte/skylight-mcp"]
    }
  }
}
```

**Claude Code:**
```bash
claude mcp add skylight -- npx @eaglebyte/skylight-mcp
```

On Windows, use `cmd /c npx @eaglebyte/skylight-mcp` as the command.

Your frame (household) and Plus subscription are detected from your account. If the account has several frames, `login` lists them; add `SKYLIGHT_FRAME_ID` to pick one.

#### From source

```bash
git clone https://github.com/TheEagleByte/skylight-mcp.git
cd skylight-mcp && npm install && npm run build
node dist/index.js login
```

Then use in mcp.json:
```json
{
  "mcpServers": {
    "skylight": {
      "command": "node",
      "args": ["/path/to/skylight-mcp/dist/index.js"]
    }
  }
}
```

### Instructions for AI

Copy this into your AI's custom instructions or system prompt:

> You have access to the Skylight MCP server. Skylight is a smart family calendar display that shows calendars, chores, grocery lists, meals, and rewards. Use the Skylight tools to help manage family schedules and organization.
>
> Tips:
> - Call `get_family_members` before assigning chores to get member names
> - Grocery items default to the main grocery list if no list specified
> - Dates accept "today", "tomorrow", day names, or YYYY-MM-DD format
> - Some tools (rewards, meals, photos) require Skylight Plus subscription

## Prerequisites

- Node.js 18+
- A Skylight account

## Authentication

### Option 1: OAuth (Recommended)

Skylight's apps sign in with OAuth 2.0 (authorization code + PKCE). Run `npx @eaglebyte/skylight-mcp login` once; the server then exchanges the saved refresh token for access tokens as needed. Skylight rotates refresh tokens on every use, so the server writes each new one back to the token file. Several server processes can share the same file.

If the refresh token expires or is revoked, the server fails with a message asking you to run `login` again.

You can also provide a refresh token directly with `SKYLIGHT_REFRESH_TOKEN` (for example in a container). It is tried after the token file's, and rotated tokens are still written to the token file.

### Option 2: Email/Password (Legacy)

The old `POST /api/sessions` login. Skylight now rejects it with *"This version of Skylight is no longer supported"*, so it only remains for compatibility.

```env
SKYLIGHT_EMAIL=your_email@example.com
SKYLIGHT_PASSWORD=your_password
SKYLIGHT_FRAME_ID=your_frame_id
```

### Option 3: Manual Token (Legacy)

Capture a token from the Skylight app using a proxy tool.

```env
SKYLIGHT_TOKEN=your_token_here
SKYLIGHT_FRAME_ID=your_frame_id
SKYLIGHT_AUTH_TYPE=bearer
```

### Finding your Frame ID

With OAuth, the frame is discovered automatically, and `login` prints every frame on the account. For the legacy options, look for the ID in API URLs like `/api/frames/{frameId}/chores`, for example in your browser's developer tools on the Skylight web app.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SKYLIGHT_TOKEN_FILE` | No | Where OAuth tokens are saved (default: `~/.skylight-mcp/tokens.json`) |
| `SKYLIGHT_REFRESH_TOKEN` | No | OAuth refresh token, if not using `login` |
| `SKYLIGHT_FRAME_ID` | Options 2–3 | Your household frame ID (OAuth: only needed if the account has several frames) |
| `SKYLIGHT_SUBSCRIPTION` | No | `plus`, `free` or `trial`; overrides the status read from your account (OAuth) |
| `SKYLIGHT_API_VERSION` | No | `Skylight-Api-Version` header sent with requests (default: `2026-10-15`) |
| `SKYLIGHT_TIMEZONE` | No | Default timezone (default: `America/New_York`) |
| `SKYLIGHT_EMAIL` | Option 2 | Your Skylight account email |
| `SKYLIGHT_PASSWORD` | Option 2 | Your Skylight account password |
| `SKYLIGHT_TOKEN` | Option 3 | Your API token |
| `SKYLIGHT_AUTH_TYPE` | No | `bearer` (default) or `basic` (for manual token) |

## Available Tools

### Calendar Tools

| Tool | Description |
|------|-------------|
| `get_calendar_events` | Get calendar events for a date range |
| `get_source_calendars` | List connected calendar sources (Google, iCloud, etc.) |

### Chore Tools

| Tool | Description |
|------|-------------|
| `get_chores` | Get chores with optional filters (date, assignee, status) |
| `create_chore` | Create a new chore with optional recurrence |

### List Tools

| Tool | Description |
|------|-------------|
| `get_lists` | Get all available lists |
| `get_list_items` | Get items from a specific list |

### Task Tools

| Tool | Description |
|------|-------------|
| `create_task` | Add a task to the task box |

### Family Tools

| Tool | Description |
|------|-------------|
| `get_family_members` | Get family member profiles |
| `get_frame_info` | Get household/frame information |
| `get_devices` | List Skylight devices |

### Reward Tools

| Tool | Description |
|------|-------------|
| `get_rewards` | Get available rewards |
| `get_reward_points` | Get reward points balance |

## Example Queries

Once configured, you can ask Claude things like:

- "What's on my calendar today?"
- "What chores do I need to do this week?"
- "Add 'take out trash' to my chores for tomorrow"
- "What's on the grocery list?"
- "Add milk to my task list"
- "Who are the family members on Skylight?"
- "How many reward points does each person have?"

## Development

```bash
# Run in development mode (with hot reload)
npm run dev

# Build
npm run build

# Run tests
npm test

# Type check
npm run typecheck
```

## API Documentation

This MCP server is built on top of the reverse-engineered Skylight API. The API endpoints were documented using the [skylight-api](https://github.com/TheEagleByte/skylight-api) project, which converts browser network traffic (HAR files) into an OpenAPI specification.

**API Resources:**
- [Interactive API Docs (Swagger UI)](https://theeaglebyte.github.io/skylight-api/swagger.html)
- [API Reference (ReDoc)](https://theeaglebyte.github.io/skylight-api/redoc.html)
- [OpenAPI Specification](https://theeaglebyte.github.io/skylight-api/openapi/openapi.yaml)

If you discover new API endpoints or find issues with the current documentation, please contribute to the [skylight-api](https://github.com/TheEagleByte/skylight-api) repository.

## Contributing

Contributions are welcome! Here's how you can help:

1. **Fork the repository** and create a feature branch
2. **Make your changes** with clear, descriptive commits
3. **Run tests** (`npm test`) and linting (`npm run lint`) before submitting
4. **Open a pull request** with a description of your changes

### Development Setup

```bash
git clone https://github.com/TheEagleByte/skylight-mcp.git
cd skylight-mcp
npm install
npm run dev  # Start with hot reload
```

### Areas for Contribution

- Adding support for new Skylight API endpoints
- Improving error handling and edge cases
- Enhancing documentation
- Writing additional tests

## Issues & Support

- **Bug reports**: [Open an issue](https://github.com/TheEagleByte/skylight-mcp/issues/new) with steps to reproduce
- **Feature requests**: [Open an issue](https://github.com/TheEagleByte/skylight-mcp/issues/new) describing the use case
- **Questions**: [Start a discussion](https://github.com/TheEagleByte/skylight-mcp/discussions) or open an issue

Please include relevant details like your Node.js version, error messages, and configuration (with sensitive values redacted).

## License

MIT

## Disclaimer

This is an unofficial integration. The Skylight API is reverse-engineered and may change without notice. Use at your own risk.
