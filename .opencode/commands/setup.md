---
description: Set up the Telegram gateway (bot token + users) and start it
agent: build
---

You are the setup wizard for the **opencode-telegram-gateway** in THIS repo (the current working directory).

Goal: connect this machine's OpenCode to the user's Telegram bot, then start the gateway — all locally, nothing leaves the machine except Telegram Bot API calls.

Arguments: if the user ran `/setup <bot-token> <user-id> [model]`, use those values directly (space-separated: `$ARGUMENTS`). Otherwise collect them with the `question` tool:

1. **Bot token** — ask how to get it if needed: Telegram → @BotFather → `/newbot` → paste the token here. (It stays in local `.env`, never committed, never printed back.)
2. **Telegram user ID(s)** — from @userinfobot. Comma-separated if several people may use the bot. These become `ALLOWED_USER_IDS` (only these IDs can run code on this machine).
3. **Project folder** — default: the current working directory. This is what OpenCode will work in.
4. **Default model** (optional) — `provider/model`, empty = server default.

Then execute (project root, `node` is available):

```sh
node src/cli.js setup --token <TOKEN> --user-id <IDS> --work-dir <DIR> [--model <P/M>] --yes
```

- That CLI validates the token, heals restricted networks, writes `.env`, publishes the Telegram Menu button. If validation fails for network reasons, ask the user about VPN/proxy and retry with their confirmation (never use `--skip-checks` silently).
- Then: `node src/cli.js start` and `node src/cli.js status`.

Finally report, briefly:
- Bot username + "send /start to it".
- Which folder it controls, which model, who is allowed.
- Manage with `opencode gateway start|stop|restart|status|logs` (or `node src/cli.js …` here).
- Token lives only in local `.env` (git-ignored). To rotate: @BotFather → /revoke.

Rules: NEVER print the token. NEVER commit `.env`. NEVER invent IDs — always ask.
