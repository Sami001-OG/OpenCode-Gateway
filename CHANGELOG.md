# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Removed
- WhatsApp (Twilio) adapter — deferred. Telegram-only for now; WhatsApp is on the roadmap.
- `express` dependency (was only needed by the WhatsApp webhook).

### Added
- `opencode-gateway` CLI: `setup` wizard (validates bot token, auto-detects your
  Telegram ID via /start, auto-heals restricted networks via DC scan, writes .env,
  publishes the Menu button, optional plugin install) + `start/stop/restart/status/logs`
  daemon control with pidfile. Non-interactive flags for CI/Docker.
- Canonical command menu (`src/commands.js`) shared by setup and docs.
- Live activity in temp messages (thinking -> grep -> edit…) via server events.
- Photo/document receiving (download + vision-attach or path-reference).
- Launch retry loop: Telegram flaps no longer kill the bot.

### Added
- Restricted-network support for Telegram: `TELEGRAM_API_IP` DC pin + `HTTPS_PROXY`.

## [0.2.0] - 2026-09-07

### Added
- Full CLI gateway parity: sessions, models, providers, agents, commands, MCP, LSP,
  config, stats, export, share/fork/summarize/revert/diff/todo/messages, shell,
  slash-commands, raw `/cli <anything>` passthrough.
- Explicit Telegram commands for all 13 built-in OpenCode tools
  (`bash, edit, write, read, grep, glob, lsp, apply_patch, skill, todowrite,
  webfetch, websearch, question`) + custom/MCP tools via plain chat.
- OpenCode plugin (`src/plugin.js`): push notifications for `session.idle`,
  `session.error`, `permission.asked` + `telegram_send` tool. Installable via npm
  (`opencode.json` → `"plugin"`) or one-file copy to `.opencode/plugins/`.
- Phone-side permission flow: `/allow` / `/deny`.
- Open-source packaging: MIT license, Dockerfile, CI workflow, contributing guide.

### Fixed
- SDK v1.18.x mismatches vs online docs: no `global.health` (ping via `path.get`),
  `mcp/lsp/formatter.status()`, top-level `postSessionByIdPermissionsPermissionId`
  with `once/always/reject`, required `agent` in shell body (defaults to `build`),
  shell output fetched via `session.messages`, `find.files` without `limit`,
  `summarize` body omitted (server defaults).

## [0.1.0] - 2026-09-07

### Added
- Initial Telegram bridge: plain-chat prompts, `/new /sessions /abort /model /status`.
- `OpencodeService` core over `@opencode-ai/sdk` + auto-started `serve`.
