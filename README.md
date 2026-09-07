<div align="center">

# 📱⚡ opencode-telegram-gateway

**Your entire OpenCode CLI — in your pocket.**

Chat with your code agent, run shell commands, approve permissions, switch models,
review diffs — all from Telegram.

[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![OpenCode](https://img.shields.io/badge/opencode-1.18.x-8A63D2)](https://opencode.ai)
[![CI](https://img.shields.io/badge/ci-passing-brightgreen)](.github/workflows/ci.yml)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#)

[Quick start](#-quick-start) · [Commands](#-command-map) · [Plugin mode](#-plugin-mode-push-notifications) · [Security](#-security-read-this-first)

</div>

---

## ✨ What is this?

`opencode` is a terminal AI coding agent. This project is a **gateway** that puts all of it
behind a Telegram bot — plus an **OpenCode plugin** that pushes events back to your phone.

```text
┌──────────┐   message    ┌──────────────────┐   SDK / CLI   ┌──────────────┐
│ Telegram │ ◄──────────► │     gateway      ├──────────────► │   opencode   │
│  (you)   │   answer     │  src/index.js    │   serve :4096  │  your code   │
└──────────┘              └──────────────────┘                └──────────────┘
        ▲                         │  OpencodeService (shared core)
        │ push events             │
        │ session idle / error / permission.asked
┌───────┴────────┐
│ opencode plugin│  src/plugin.js → opencode.json "plugin": ["opencode-telegram-gateway"]
└────────────────┘
```

### Why it's different

| Feature | This gateway |
|---|---|
| Plain chat = full agent with **all 13 built-in tools** + custom + MCP | ✅ |
| Explicit per-tool commands (`/bash`, `/read`, `/grep`…) | ✅ |
| Raw `/cli <anything>` — full CLI parity | ✅ |
| Approve/deny permission prompts from your phone | ✅ |
| Installable as an OpenCode plugin (npm **or** one file) | ✅ |
| Docker + CI + tests out of the box | ✅ |

---

## 🚀 Quick start

**Prerequisites:** [Node.js](https://nodejs.org) ≥ 20 · `opencode --version` works (gateway drives *your* OpenCode + auth) · a Telegram account.

**1. Create the bot (2 min).** In Telegram: **@BotFather** → `/newbot` → copy the token.
Then **@userinfobot** → copy your numeric chat ID.

**2. Run the gateway.**

```powershell
git clone https://github.com/Sami001-OG/OpenCode-Gateway.git
cd opencode-telegram-gateway
npm install
node src/cli.js setup     # wizard: bot token, your user ID, folder (validates + heals network + publishes menu)
node src/cli.js start     # background daemon; `restart`, `stop`, `status`, `logs` likewise
```

Or global (use from any folder): `npm i -g opencode-telegram-gateway`, then `opencode-gateway setup` / `opencode-gateway start`.

<details>
<summary><b>⌨️ Want the exact spelling <code>opencode gateway start</code>?</b></summary>

The `opencode` CLI doesn't dispatch unknown words to packages, so this repo ships
`opencode-gateway` plus a tiny forwarder. PowerShell (`$PROFILE`):

```powershell
function opencode { if ($args[0] -eq 'gateway') { opencode-gateway @($args | Select-Object -Skip 1) } else { & opencode.exe @args } }
```

Bash/Zsh (`~/.bashrc` / `~/.zshrc`):

```sh
opencode() { if [ "$1" = "gateway" ]; then shift; opencode-gateway "$@"; else command opencode "$@"; fi }
```

Then `opencode gateway setup|start|stop|restart|status|logs` works, everything else passes through untouched.

</details>

**3. Say hi.** In Telegram → `/start` → send `list files here` → send `create hello.py that prints hi and run it`.

<details>
<summary><b>🐳 Docker</b></summary>

```sh
docker build -t oc-tg .
docker run --env-file .env -v /path/to/project:/work oc-tg
```

</details>

<details>
<summary><b>📦 npx (after publish)</b></summary>

```sh
npx opencode-telegram-gateway
```

</details>

---

## 🧰 Command map

### 💬 Sessions & agent

| You send | OpenCode equivalent |
|---|---|
| plain text | `session.prompt` — agent with **every tool** |
| `/new [title]` | `session.create` (fresh context) |
| `/sessions` | `session.list` |
| `/use <id>` | switch active session |
| `/abort` | `session.abort` |
| `/share` / `/unshare` | share link on/off |
| `/fork` | `session.fork` (branch it) |
| `/summarize` | `session.summarize` |
| `/undo <messageID>` | `session.revert` |
| `/diff` | files changed this session |
| `/todo` | session todo list |
| `/messages` | last messages + IDs |
| `/run <prompt>` | one-shot agent run |

### 🔧 Tools — every one reachable

All 13 built-ins work automatically in plain chat. These force a specific tool:

| Command | Tool | Notes |
|---|---|---|
| `/bash <cmd>` | `bash` | via agent (permissions + audit like CLI) |
| `/shell <cmd>` | session shell | logged in transcript |
| `/read <path>` | `read` | ⚡ direct API, no LLM cost |
| `/edit <p> :: <old> :: <new>` | `edit` | guided |
| `/write <p> :: <content>` | `write` | guided |
| `/grep <regex>` · `/find <text>` | `grep` | ⚡ direct API |
| `/glob <pattern>` | `glob` | ⚡ direct API |
| `/ls [path]` | file list | ⚡ direct API |
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

When OpenCode needs approval, you get a push (via plugin mode below) and reply:

```text
/allow <permissionID>    → approve once
/deny <permissionID>     → reject
```

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
```

---

## 🗺️ Roadmap

- WhatsApp adapter — planned, deferred for now. Telegram is the supported transport.

---

## ⚙️ Configuration

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
| `TELEGRAM_API_IP` | – | pin `api.telegram.org` to a reachable DC IP (restricted networks, no admin needed) |
| `HTTPS_PROXY` | – | proxy for Telegram traffic (e.g. where the direct route is blocked) |

---

## 🔒 Security — read this first

- **`ALLOWED_USER_IDS` must be set.** Empty = anyone who finds the bot gets code execution on your machine.
- The gateway inherits **your** OpenCode auth + file access. Start with a scratch `WORK_DIR`, not `C:\`.
- `/cli`, `/bash`, `/shell` are remote code execution **by design** — that's the point of a full gateway. Gate them, and set conservative `permission` rules in `opencode.json` until you trust the flow.
- Never commit `.env` (already git-ignored). Rotate the BotFather token if it ever leaks.

---

## 🗺️ Repo map

```text
src/index.js             Telegram gateway — every command
src/opencode-service.js  core used by the gateway (and future transports)
src/net.js               restricted-network helpers (DC pin, proxy) for Telegram
src/plugin.js            OpenCode plugin — pushes + telegram_send tool (zero-dep, copy-pasteable)
plugin.js                npm plugin entry (side-effect free — bot never starts on import)
Dockerfile               container run
.github/workflows/ci.yml syntax checks on push/PR
```

## 🤝 Contributing

PRs welcome! See [CONTRIBUTING.md](CONTRIBUTING.md): `npm install && npm test` must pass,
new commands need handler + core logic + docs in this README.

## 📄 License

[MIT](LICENSE) — free for personal and commercial use.

---

<div align="center">

Built for people who'd rather ship from the couch. 🛋️

</div>
