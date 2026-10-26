# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **OAuth authentication**: Skylight's apps now sign in with OAuth 2.0 (authorization code + PKCE). A new `skylight-mcp login` command signs in through Skylight's own page and saves tokens to `~/.skylight-mcp/tokens.json` (`SKYLIGHT_TOKEN_FILE`). The server refreshes access tokens automatically, persists rotated refresh tokens, and copes with several processes sharing the token file. `SKYLIGHT_REFRESH_TOKEN` can seed it instead.
- **Frame discovery**: With OAuth, `SKYLIGHT_FRAME_ID` is optional when the account has a single frame (`GET /api/frames`).
- **Subscription detection**: With OAuth, Plus status is read from `GET /api/user`; `SKYLIGHT_SUBSCRIPTION` overrides it.

### Fixed

- **Authentication**: Requests now send the `Skylight-Api-Version` header (`SKYLIGHT_API_VERSION`, default `2026-10-15`). Fixes "This version of Skylight is no longer supported" (#42, #43). The legacy `/api/sessions` email/password login is still rejected by Skylight; use `login` instead.

## [1.1.7] - 2025-12-30

### Fixed

- **Authentication**: Fixed email/password authentication to use correct `Basic base64(userId:token)` format instead of `Bearer token`. The Skylight API requires the user ID and token to be combined and base64-encoded for Basic auth.
- **Calendar Events**: Fixed `get_calendar_events` returning no events when querying a single day. The API treats `date_max` as exclusive, so we now add 1 day to ensure events on the end date are included.

### Changed

- Added debug logging for authentication flow to help troubleshoot login issues
- Added automatic retry on 401 errors for email/password auth (attempts re-login once before failing)

## [1.1.6] - 2025-12-29

- Initial public release
