<div align="center">

# 📱⚡ opencode-telegram-gateway

**Your entire OpenCode CLI — in your pocket.**

Chat with your code agent, run shell commands, send photos and documents,
approve permissions, switch models, review diffs — all from Telegram.
Heavy tasks survive flaky networks; restarts take seconds.

[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![OpenCode](https://img.shields.io/badge/opencode-1.18.x-8A63D2)](https://opencode.ai)
[![CI](https://img.shields.io/badge/ci-passing-brightgreen)](.github/workflows/ci.yml)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#)

[How it works](#-how-it-works) · [Quick start](#-quick-start) · [Everyday use](#-everyday-use) · [Commands](#-command-map) · [Computer controls](#-computer-controls) · [Restricted networks](#-restricted-networks) · [Troubleshooting](#-troubleshooting) · [Security](#-security-read-this-first)

</div>

---

## ✨ What is this?

[`opencode`](https://opencode.ai) is a terminal AI coding agent. This project puts all of it
behind a Telegram bot — plus an OpenCode plugin that pushes events back to your phone.

```text
┌──────────┐   message    ┌──────────────────┐   SDK / CLI   ┌──────────────┐
│ Telegram │ ◄──────────► │     gateway      ├──────────────► │   opencode   │
│  (you)   │   answer     │  src/index.js    │   serve :4096  │  your code   │
└──────────┘              └──────────────────┘                └──────────────┘
        ▲                         │  OpencodeService: sessions, tools,
        │ push events             │  files, models, raw CLI passthrough
        │ permission / errors     │  net.js: auto-route (direct→pin→proxy)
┌───────┴────────┐
│ opencode plugin│  src/plugin.js → opencode.json "plugin": ["opencode-telegram-gateway"]
└────────────────┘
```

Why it's built this way:

| Design choice | Why |
|---|---|
| Plain chat = full agent (all 13 built-in tools + custom + MCP) | No watered-down "bot commands" — it's really opencode |
| Explicit per-tool commands (`/bash`, `/read`, `/grep`…) | Precision when you want exactly one tool |
| Raw `/cli <anything>` passthrough | Full CLI parity; anything new in opencode works day one |
| Fire-and-poll task execution (no long-lived HTTP) | Heavy tasks can't die with "fetch failed" |
| Retries on every Telegram call + self-healing event stream | Survives VPN flaps and throttled networks |
| Attach-first restarts | Reuses the warm server — restarts take seconds |
| Installable as an OpenCode plugin (npm **or** one file) | Push alerts + `telegram_send` tool for the agent |
| Docker + CI + tests out of the box | Clone-and-go for anyone |

---

## 🚀 Quick start

**Prerequisites:** [Node.js](https://nodejs.org) ≥ 20 · `opencode --version` works (the gateway drives *your* OpenCode and auth) · a Telegram account.

**1. Create the bot (2 min).** In Telegram: **@BotFather** → `/newbot` → copy the token.
Then **@userinfobot** → copy your numeric chat ID.

**2. Install.**

```powershell
git clone https://github.com/Sami001-OG/OpenCode-Gateway.git
cd OpenCode-Gateway
npm install
powershell -ExecutionPolicy Bypass -File .\install-wrapper.ps1  # one time: adds `opencode setup` + `opencode gateway ...`
# restart your terminal, then:
opencode setup     # wizard inside the opencode TUI: token, user ID(s), folder — then it auto-starts
# ...or the plain terminal wizard (7 guided steps with a review screen):
opencode gateway setup
```

That's it. The wizard validates your bot, heals restricted networks automatically,
writes `.env`, publishes the Menu ☰ button with all 46 commands, and offers to start
the gateway. `opencode gateway start` then opens a live dashboard (status, sessions,
log tail — `q` detaches, `r` restarts, `s` stops, `l` shows more log).

> On macOS/Linux use `sh install-wrapper.sh` instead. Without the wrapper (or for
> global use): `node src/cli.js setup` / `node src/cli.js start`, or
> `npm i -g opencode-telegram-gateway` then `opencode-gateway setup|start|…`.

**3. Say hi.** In Telegram → `/start` → send `list files here` → send a photo and ask
about it → send `create hello.py that prints hi and run it`.

<details>
<summary><b>🐳 Docker</b></summary>

```sh
docker build -t oc-tg .
docker run --env-file .env -v /path/to/project:/work oc-tg
```

Note: the container runs the gateway directly (`src/index.js`); daemon commands
(`start/stop/restart`) are for host installs.

</details>

---

## 📲 Everyday use

- **Just talk.** `fix the login bug on the staging branch` — the agent uses whatever tools it needs.
- **Watch it work.** The temp message is live: `💭 thinking…` → `🔍 searching code…` → `✏️ editing files…` → answer. `/abort` stops anything.
- **Send files.** Photos decode through vision; documents (PDF, code, text, GIFs…) are downloaded into `.telegram-uploads/` and handed to the agent with their path. Add a caption to say what to do with them.
- **Switch context by name.** `/sessions` shows a numbered list (`1. "Fix login bug" (ses_1638…)` ▶ marks current) and `/use 1` or `/use login` switches — no ID pasting.
- **Approve from the couch.** Permission prompts arrive as pushes; `/allow <id>` / `/deny <id>`.
- **Change engine mid-chat.** `/model teamorouter/deepseek-v4-pro-free`, `/agent plan`.

---

## 🧰 Command map

### 💬 Sessions & agent

| You send | OpenCode equivalent |
|---|---|
| plain text | agent run with **every tool** |
| `/new [title]` | `session.create` (fresh context) |
| `/sessions` | `session.list` — numbered, by name, current marked ▶ |
| `/use <number, name, or id>` | switch active session |
| `/abort` | `session.abort` |
| `/share` / `/unshare` | share link on/off |
| `/fork` | `session.fork` (branch it) |
| `/summarize` | `session.summarize` |
| `/undo <messageID>` | `session.revert` (see IDs in `/messages`) |
| `/diff` | files changed this session |
| `/todo` | session todo list |
| `/messages` | last messages + IDs |
| `/run <prompt>` | one-shot agent run |

### 🔧 Tools — every one reachable

All 13 built-ins work automatically in plain chat. These force a specific tool
(read-only ones hit the API directly — fast, no LLM cost):

| Command | Tool | Notes |
|---|---|---|
| `/bash <cmd>` | `bash` | via agent (permissions + audit like CLI) |
| `/shell <cmd>` | session shell | logged in transcript |
| `/read <path>` | `read` | ⚡ no LLM cost |
| `/edit <p> :: <old> :: <new>` | `edit` | guided |
| `/write <p> :: <content>` | `write` | guided |
| `/grep <regex>` · `/find <text>` | `grep` | ⚡ no LLM cost |
| `/glob <pattern>` | `glob` | ⚡ no LLM cost |
| `/ls [path]` | file list | ⚡ no LLM cost |
| `/webfetch <url>` | `webfetch` | |
| `/websearch <query>` | `websearch` | |
| `/skill <name>` | `skill` | loads a `SKILL.md` |
| `/todoadd <text>` | `todowrite` | |
| `/lsp <request>` | `lsp` | e.g. `hover src/index.ts:10:5` |
| `/ask <topic>` | `question` | agent questions **you** |

### 🧠 Models, agents & system

`/model provider/model` · `/model reset` · `/agent <name>` · `/agents` · `/models [provider]` ·
`/providers` · `/commands` · `/mcp` · `/lspstatus` · `/tools` · `/config` · `/health` · `/status` · `/stats`

### 🛠️ Raw CLI — the "everything" button

```text
/cli <args...>     → runs `opencode <args...>` and returns the output
```

Examples: `/cli models anthropic` · `/cli session list` · `/cli mcp list` · `/cli export <id>` · `/cli --help`

> Interactive / long-running commands can't work over messages by nature: the TUI,
> `serve`, `web`, `attach`, `acp`. The gateway already runs `serve` for you, so you lose
> nothing. `/cli` kills anything still running after 120s. Set `CLI_ENABLED=false` to disable.

### ✅ Permissions from your phone

```text
/allow <permissionID>    → approve once
/deny <permissionID>     → reject
```

---

## 💻 Computer controls

(With the wrapper: `opencode gateway …`; without: `opencode-gateway …` or `node src/cli.js …`.)

| Command | What |
|---|---|
| `setup [--token X --user-id Y --work-dir Z --model P/M --agent A --port N --yes --skip-checks --no-menu]` | Guided 7-step wizard (token → connection → users → folder → model → review → save) |
| `start [--dir DIR] [--no-ui]` | Background daemon; attaches to a warm server when one exists, then opens the live dashboard UI |
| `dashboard [--dir DIR]` | Reopen the live dashboard UI (status, sessions, log tail, `q`/`r`/`s`/`l` keys) |
| `stop [--dir DIR]` | Stop gateway; frees the port only from orphaned servers, never yours |
| `restart [--dir DIR]` | Fast restart (keeps warm server → seconds, not minutes) |
| `status [--dir DIR]` | pid, port holder, config sanity |
| `logs [--dir DIR] [-n 60]` | Tail the gateway log |
| `opencode setup` | Same wizard, but inside the opencode TUI (`/setup` command) |

---

## 🔌 Plugin mode (push notifications)

The gateway polls; the **plugin** pushes. Install it so `session.idle`, `session.error`
and `permission.asked` land in your Telegram inbox, and the agent gains a `telegram_send` tool.

**Option A — npm (recommended):**

```jsonc
// opencode.json
{ "$schema": "https://opencode.ai/config.json", "plugin": ["opencode-telegram-gateway"] }
```

**Option B — one file:** copy `src/plugin.js` → `.opencode/plugins/telegram-gateway.js`
(project) or `~/.config/opencode/plugins/` (global). Zero dependencies.

```env
# env inside the opencode process
TELEGRAM_BOT_TOKEN=...
TELEGRAM_NOTIFY_CHAT_IDS=123,456
TELEGRAM_NOTIFY_ON=session.idle,session.error,permission.asked
TELEGRAM_NOTIFY_TOOLS=true   # optional: notify after every tool call (noisy)
```

---

## 🌐 Restricted networks

If Telegram is throttled or blocked on your network, setup connects automatically —
no extra accounts, no VPN required in most cases:

1. **direct** — plain `api.telegram.org` (works for almost everyone);
2. **pinned endpoint** — automatic TLS scan for a reachable, certificate-verified Telegram frontend;
3. **`HTTPS_PROXY`** — picked up automatically when set;
4. **clear diagnosis** — if everything fails you get the exact broken layer (`TCP blocked`, `TLS interfered`, …) plus options (VPN, proxy, own relay).

The gateway re-resolves the route every few minutes on its own, so it heals itself
when the network changes — no restart needed. Power users can additionally point
everything at their own reverse proxy (generic — any proxy you trust, no vendor
needed) via `TELEGRAM_API_ROOT`.

---

## ⚙️ Configuration

All set by the wizard into `.env` (never committed):

| Var | Required | What |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | @BotFather token |
| `ALLOWED_USER_IDS` | ✅ | comma-separated Telegram IDs (`@userinfobot`) |
| `WORK_DIR` | ✅ | folder OpenCode works in |
| `OPENCODE_SERVER_URL` | – | attach to existing `serve`/`web` instead of starting one |
| `OPENCODE_HOSTNAME` / `OPENCODE_PORT` | – | defaults `127.0.0.1:4096` |
| `OPENCODE_MODEL` / `OPENCODE_AGENT` | – | per-chat defaults (overridable via `/model`, `/agent`) |
| `CLI_ENABLED` | – | `false` disables raw `/cli` passthrough |
| `TELEGRAM_NOTIFY_CHAT_IDS` | plugin | where pushes go |
| `TELEGRAM_NOTIFY_ON` / `TELEGRAM_NOTIFY_TOOLS` | plugin | which events push |
| `TELEGRAM_API_IP` | auto | pinned endpoint (setup finds it; rarely set by hand) |
| `HTTPS_PROXY` | – | proxy for Telegram traffic |
| `TELEGRAM_API_ROOT` | – | custom Bot API root / trusted reverse proxy |

---

## 🩺 Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| Bot silent, log says `TCP blocked/throttled` | Network blocks Telegram → VPN/proxy, or wait for auto-heal |
| `Model not found: X. Did you mean: Y?` | Stale default model → `/model <provider>/<model>` from `/models` |
| `(empty response…)` / `Error:` after a task | Real opencode error, now surfaced verbatim — read it, often model/auth |
| `Still working on your last message` | One task per chat at a time → `/abort` or wait |
| `Port 4096 held…` on start | Attach happens automatically if it's opencode; else stop the holder or change port |
| `409 Conflict` / duplicate replies | Two gateways polling one token → `stop`, kill strays, `start` |
| Slow first start | One-time cache warm-up (models, LSP, plugins) + your MCP servers; restarts attach instantly |
| Media fails with `download failed…` | Telegram route flaky mid-transfer — resend; check route via `logs` |
| `Unauthorized.` | Your ID isn't in `ALLOWED_USER_IDS` — the gateway logs sender IDs on boot machine |

Logs live next to `.env`: `gateway.log` (bot + server milestones) and `gateway.err.log`.
Run `opencode gateway logs` / `status` before anything else.

---

## 🔒 Security — read this first

- **`ALLOWED_USER_IDS` must be set.** Empty = anyone who finds the bot gets code execution on your machine.
- The gateway inherits **your** OpenCode auth + file access. Start with a scratch `WORK_DIR`.
- `/cli`, `/bash`, `/shell` are remote code execution **by design**. Gate them, and keep conservative `permission` rules in `opencode.json` until you trust the flow.
- Never commit `.env` (git-ignored). Bot tokens also never appear in logs (scrubbed) — but rotate in BotFather if one ever leaks anywhere.

---

## 🗂️ Repo map

```text
src/index.js             Telegram gateway — every command
src/opencode-service.js  core: sessions, tools, resilient task runner, activity feed
src/net.js               auto-route engine (direct→pin→proxy→diagnose) + Bot API client
src/cli.js               opencode-gateway: setup wizard + daemon control
src/commands.js          canonical Telegram menu (published by setup)
src/plugin.js            OpenCode plugin — pushes + telegram_send tool (zero-dep)
.opencode/commands/setup.md   /setup TUI wizard (delegates to the CLI)
install-wrapper.ps1/.sh  `opencode setup` + `opencode gateway …` shell shortcuts
plugin.js                npm plugin entry (side-effect free)
Dockerfile               container run
.github/workflows/ci.yml checks on push/PR
```

## 🗺️ Roadmap

- WhatsApp adapter — planned, deferred. Telegram is the supported transport.
- npm publish (`opencode-gateway` global), Windows auto-start task.

## 🤝 Contributing

PRs welcome! See [CONTRIBUTING.md](CONTRIBUTING.md): `npm install && npm test` must pass;
new Telegram commands need handler + core logic + menu entry + docs here.

## 📄 License

[MIT](LICENSE) — free for personal and commercial use.

---

<div align="center">

Built for people who'd rather ship from the couch. 🛋️

</div>
