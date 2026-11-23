# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Removed
- WhatsApp (Twilio) adapter — deferred. Telegram-only for now; WhatsApp is on the roadmap.
- `express` dependency (was only needed by the WhatsApp webhook).

### Added
- `opencode-gateway` CLI: `setup` wizard (validates bot token, auto-detects your
  Telegram ID via /start, auto-heals restricted networks, writes .env,
  publishes the Menu button, optional plugin install) + `start/stop/restart/status/logs`
  daemon control with pidfile. Non-interactive flags for CI/Docker.
- `opencode setup` TUI wizard (`.opencode/commands/setup.md`) + shell wrappers
  (`install-wrapper.ps1/.sh`) for the exact `opencode setup|gateway …` spelling.
- Auto-route engine: direct → TLS-verified DC pin → proxy → precise diagnosis
  (no accounts needed); `TELEGRAM_API_ROOT` generic relay hatch; launch retries
  with periodic route re-resolution.
- Heavy-task resilience: promptAsync + status polling (no long-lived HTTP),
  per-poll retries, Telegram call retries with backoff, SSE auto-reconnect.
- Sessions by name: numbered `/sessions` list, `/use` by number/name/id.
- Live activity in temp messages (thinking → tool labels) from server events.
- Photo/document receiving (download + vision-attach or path reference).
- Attach-first restarts (reuse warm server, seconds not minutes), boot timings,
  live progress in `start`, orphan-only port cleanup, PID-reuse guard.
- Token scrubbing in all log output.
- Canonical command menu (`src/commands.js`) shared by setup and docs.
- Behavioural test suite (`node --test`) covering session tracking, duplicate-run
  prevention, Windows `/cli` quoting and menu/handler consistency. `npm test` now
  runs it in addition to syntax checks.

### Fixed
- **No-text fallback during long reasoning**: v2 can report idle while reasoning
  streams; the fallback now also requires 4s of SSE silence, so real answers are
  no longer dropped.
- **Stale Telegram command menu**: commands (including `/restart`) are now
  re-published at every boot with `setMyCommands` + `setChatMenuButton`.

### Changed
- **Latency**: first poll now happens immediately (no guaranteed 3s sleep), poll
  interval dropped from 3s to 500ms, the pre-prompt message-list API call was
  removed, and fast read-only commands skip the temp "Working…" send/edit/delete
  round-trips. A boot-time warm-up prompt (disable with `WARMUP_ON_BOOT=false`)
  absorbs one-time model initialisation. Measured: warm answers ~1.5–1.9s vs
  ~6s cold before.
- **v2 streaming fixed**: v2 emits `session.text.delta` (incremental), now
  accumulated and fed to Telegram drafts; streaming throttle reduced to 250ms.
- **Answer correctness**: messages are ordered by timestamp, and only assistant
  messages created after the current prompt count as its answer.

### Added
- **Chat-initiated restart**: `/restart` (and the 🔌 Platform menu button) cleanly closes
  the OpenCode server, clears the pidfile, relaunches the detached daemon and exits.
- **OpenClaw/Hermes-inspired feature merge**: native `sendMessageDraft` streaming with
  Stop button, Telegram inline mode, group mention activation + per-topic sessions,
  voice-note intake, persistent memory with `@file` references, `/checkpoint`/`/rollback`,
  `/schedule` recurring jobs, `/skills` and `/worktree` (v2), webhook launch mode,
  Mini App button, `TOOL_POLICY_DENY`, and a dual v1/v2 plugin entrypoint.
- **Merged Telegram + OpenCode feature audit** (50 focused subagent reviews): wired
  v2 session operations that exist on the real server (fork, compact/summarize,
  revert, diff, shell, command), v2 permission replies, v2 model/agent switching,
  live SSE event normalization, owner-bound expiring permission buttons with
  "Always", per-menu pagination, and fail-closed `ALLOWED_USER_IDS`.
- **Model variants**: model buttons now offer the model's variants (e.g. reasoning
  effort); selecting one sets `provider/model:variant`, also accepted by `/model`.
- **Interactive Telegram UI** (`src/interactive.js`): `/menu` opens inline-keyboard
  menus for sessions, models (paginated), agents, providers, tools, slash commands
  and system actions. Model/agent/session selection applies immediately; permission
  pushes include Allow/Deny buttons. Callback payloads use short indexes (64-byte
  safe) and are gated by `ALLOWED_USER_IDS`.
- **Termux/Android support**: daemon no longer relies on `/proc/<other-pid>`
  (Android hides it) — uses `ps`, with `ss`/`fuser` fallbacks for port lookup.
  Install wrapper prints Termux-specific guidance.
- **Both OpenCode API generations supported**: v1 (`<= 1.19.x`) and v2 (`>= 2.x`,
  `/api` + Basic auth). The gateway reads the v2 `server password` from the
  startup log; `OPENCODE_SERVER_PASSWORD` covers manually attached v2 servers.

### Fixed
- `/use` and `/fork` now keep the session→user map in sync, so live tool/activity
  labels keep working after switching sessions.
- Flaky-network duplicate runs: `promptAsync` retries now verify the prompt actually
  landed (busy status or a matching new user message) before re-posting, so a lost
  response can no longer execute a task twice.
- Windows `/cli`: every argument is quoted for cmd.exe and shell metacharacters,
  `%VAR%`/`!VAR!` expansion tokens and CR/LF/NUL are rejected.
- `/unshare` added to the canonical command menu and `/help` (48 commands).
- Docker image now installs the `opencode` CLI and builds from the lockfile; README
  no longer claims periodic route re-resolution (it happens on failed launches).

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
