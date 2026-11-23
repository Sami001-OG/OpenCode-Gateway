// Telegram gateway for OpenCode — every CLI area + every tool, from your phone.
// Install: npm install, copy .env.example to .env, npm start
// Open-source: https://github.com/YOU/opencode-telegram-gateway
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Telegraf, Markup } from "telegraf";
import { BUILTIN_TOOLS, OpencodeService, errorMessage } from "./opencode-service.js";
import { createTelegramAgent, downloadTelegramFile, telegramApi, apiTarget } from "./net.js";
import { TelegramUI } from "./interactive.js";
import { Streaming } from "./streaming.js";
import { Scheduler } from "./automation.js";
import { Memory } from "./memory.js";
import { Checkpoints } from "./checkpoints.js";
import { scheduleRestart } from "./restart.js";

const {
  TELEGRAM_BOT_TOKEN = "",
  ALLOWED_USER_IDS = "",
  WORK_DIR = "",
  OPENCODE_SERVER_URL = "",
  OPENCODE_HOSTNAME = "127.0.0.1",
  OPENCODE_PORT = "4096",
  OPENCODE_MODEL = "",
  OPENCODE_AGENT = "",
  CLI_ENABLED = "true",
} = process.env;

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Copy .env.example to .env and add your BotFather token.");
  process.exit(1);
}

const allowed = new Set(ALLOWED_USER_IDS.split(",").map((s) => s.trim()).filter(Boolean));
if (allowed.size === 0) {
  // An open bot is remote code execution for anyone who finds it — require an
  // explicit, written opt-in instead of failing open by default.
  if (String(process.env.ALLOW_OPEN_BOT ?? "").toLowerCase() !== "true") {
    console.error("[security] ALLOWED_USER_IDS is empty. Refusing to start: set numeric IDs, or set ALLOW_OPEN_BOT=true to knowingly allow anyone.");
    process.exit(1);
  }
  console.warn("[security] ALLOW_OPEN_BOT=true — ANY Telegram user who finds this bot can run code on your machine.");
}

if (WORK_DIR && fs.existsSync(WORK_DIR)) {
  process.chdir(WORK_DIR);
  console.log(`[bridge] working directory: ${process.cwd()}`);
} else if (WORK_DIR) {
  console.warn(`[bridge] WORK_DIR does not exist: ${WORK_DIR} — using ${process.cwd()}`);
}

const BOOT_T0 = Date.now();
const bootSecs = () => `${Math.round((Date.now() - BOOT_T0) / 1000)}s`;
let GATEWAY_VERSION = "?";
try {
  GATEWAY_VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "?";
} catch {}
console.log(`[bridge] opencode-telegram-gateway v${GATEWAY_VERSION} booting…`);
const opencode = new OpencodeService({
  defaultModel: OPENCODE_MODEL,
  cliEnabled: CLI_ENABLED !== "false",
});
console.log(`[boot] starting opencode server…`);
await opencode.init({ serverUrl: OPENCODE_SERVER_URL, hostname: OPENCODE_HOSTNAME, port: OPENCODE_PORT });
console.log(`[boot] opencode server ready in ${bootSecs()}${OPENCODE_SERVER_URL ? " (attached to existing server)" : ""}`);
if (OPENCODE_AGENT) console.log(`[bridge] default agent: ${OPENCODE_AGENT || "(none)"}`);

// Absorb the one-time model/provider warm-up in the background so the first
// real chat message feels as fast as the CLI. Disable with WARMUP_ON_BOOT=false.
if (String(process.env.WARMUP_ON_BOOT ?? "true").toLowerCase() === "true") {
  opencode.prompt("__warmup", "Reply with: OK").catch(() => {});
}

const telegramAgent = await createTelegramAgent();
const apiT = apiTarget();
const bot = new Telegraf(TELEGRAM_BOT_TOKEN, {
  telegram: {
    ...(apiT.isDefaultHost ? {} : { apiRoot: apiT.root }),
    ...(telegramAgent ? { agent: telegramAgent } : {}),
  },
});
const threadId = (ctx) => ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id ?? 0;
// Conversations are isolated per user, chat and topic (private topics supported).
const key = (ctx) => `${ctx.from.id}:${ctx.chat?.id ?? "private"}:${threadId(ctx)}`;
const threadExtra = (ctx) => threadId(ctx) ? { message_thread_id: threadId(ctx) } : {};
const arg = (ctx) => String(ctx.message?.text ?? ctx.inlineQuery?.query ?? "").replace(/^\/\w+(@\w+)?\s*/, "").trim();

// Interactive inline-keyboard UI (models, agents, sessions, permissions, …).
// Registered after the auth middleware below, so buttons are gated too.
const ui = new TelegramUI(bot, opencode, key);
// Runtime features are attached after construction to avoid circular init.
ui.features = {};

// Telegram chat ids per user — needed to address streaming drafts.
const chatIds = new Map();
const threadIds = new Map();
const streaming = new Streaming(bot, opencode, (k) => chatIds.get(k));
streaming.register();

const scheduler = new Scheduler(
  process.cwd(),
  (prompt) => opencode.prompt("schedule", prompt),
  (job, text) => bot.telegram.sendMessage(job.chatId, String(text).slice(0, 4000),
    job.threadId ? { message_thread_id: job.threadId } : undefined)
);
scheduler.start();

const memory = new Memory(process.cwd());
const checkpoints = new Checkpoints(process.cwd());
Object.assign(ui.features, {
  scheduler, memory, checkpoints, streaming,
  restart: () => scheduleRestart(process.cwd(), opencode),
});

const HELP = `OpenCode gateway — dir: ${process.cwd()}

Just type normally: I run it in OpenCode with ALL tools (bash/edit/read/grep/glob/web/skill/todo/lsp/MCP...).
Send photos or documents too — I download and attach them (tap Menu ☰ for every command).
/menu — interactive button menus for models, agents, sessions, tools, providers and system.

SESSIONS
/new [title] — fresh session
/sessions — recent sessions (by name)
/use <number, name, or id> — switch session
/abort — stop running task
/share — public link for session
/unshare — remove public link
/fork — branch current session
/summarize — compact summary
/undo <messageID> — revert a message
/diff — files changed this session
/todo — session todo list
/messages — last messages

TOOLS (explicit single-tool use)
/bash <cmd> — run shell via opencode
/read <path> — read file (free, no LLM)
/edit <path> :: <old> :: <new> — guided edit
/write <path> :: <content> — guided write
/grep <regex> [glob] — search code (free)
/glob <pattern> — find files (free)
/find <text> — alias for grep
/ls <path> — list files (free)
/webfetch <url> — fetch page via opencode
/websearch <query> — web search via opencode
/skill <name> — load a skill
/todoadd <text> — add via todowrite tool
/lsp <request> — code intelligence
/ask <q> — ask opencode to question YOU (answers come as reply)

MODELS / AGENTS / SYSTEM
/model provider/model — or /model reset
/agent <name> — or /agent reset
/models [provider] — list models
/providers — list providers
/agents — list agents
/commands — slash commands
/mcp — MCP server status
/lspstatus — LSP status
/tools — all available tools
/config — opencode config
/health — server health
/stats — token/cost stats (CLI)

RAW CLI (full parity)
/cli <args...> — e.g. /cli models anthropic
/shell <cmd> — session shell (logged in transcript)
/run <prompt> — one-shot non-interactive run
/export [id] — export session JSON

AUTOMATION
/schedule <minutes> :: <prompt> — recurring job (list/rm via /schedule, /schedule rm <id>)
/skills — list OpenCode skills (v2)
/worktree [new|rm] — manage v2 worktrees
/remember <fact> · /memory — persistent memory
/checkpoint [label] · /rollback [id] — file snapshots
Voice notes are transcribed; @file references inject file contents.
/stream [on|off] · /inline · /groups · /voice · /webhook · /app · /policy
/restart — restart the gateway daemon (reconnect in a few seconds)
`;

function isAllowed(ctx) {
  if (allowed.size === 0) return true;
  return allowed.has(String(ctx.from.id));
}

function chunk(text, size = 4000) {
  const out = [];
  let s = String(text ?? "");
  if (!s) return ["(empty)"];
  while (s.length > size) {
    let cut = s.lastIndexOf("\n", size);
    if (cut < size * 0.4) cut = size;
    out.push(s.slice(0, cut));
    s = s.slice(cut);
  }
  out.push(s);
  return out;
}

async function replyLong(ctx, text) {
  for (const part of chunk(text)) await tgCall(() => ctx.reply(part, threadExtra(ctx)));
}

// Telegram calls fail transiently on flaky routes (VPN flaps, throttled DCs).
// Retry with backoff; some errors are permanent — fail fast on those.
async function tgCall(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const m = String(e?.message ?? e);
      const code = e?.code ?? e?.response?.error_code ?? e?.response?.statusCode;
      if (code === 401 || /bot was blocked|chat not found/i.test(m)) throw e; // permanent
      if (/message is not modified|message to edit not found|message to delete not found/i.test(m)) throw e;
      if (code === 429 || /too many requests/i.test(m)) {
        const retryAfter = Number(e?.parameters?.retry_after ?? e?.response?.parameters?.retry_after ?? 5);
        await new Promise((r) => setTimeout(r, Math.min(Math.max(retryAfter, 1), 30) * 1000));
      } else {
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
    }
  }
  throw last;
}

function fmtJson(v, max = 3800) {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > max ? s.slice(0, max) + `\n…(truncated ${s.length - max} chars)` : s;
}

// Bot tokens leak into Bot API error URLs — scrub before any log output.
const scrub = (s) => String(s ?? "").replace(/\/bot\d+:[\w-]+/g, "/bot<redacted>");

async function runAndReply(ctx, label, fn, { quiet = false } = {}) {
  let working = null;
  const keepers = [];
  try {
    if (!quiet) {
      await streaming.begin(key(ctx));
      await tgCall(() => ctx.sendChatAction("typing")).catch(() => {});
      working = await tgCall(() => ctx.reply(`${label}… (/abort to stop)`, threadExtra(ctx)));
      keepers.push(setInterval(() => ctx.sendChatAction("typing").catch(() => {}), 4500));
      // Live activity: rewrite the temp message as the harness switches tools
      // (thinking -> grep -> edit -> ...). Throttled to respect Telegram limits.
      let lastShown = `${label}…`;
      keepers.push(setInterval(async () => {
        try {
          const a = opencode.getActivity(key(ctx));
          if (a && a !== lastShown && working) {
            lastShown = a;
            await tgCall(() => ctx.telegram.editMessageText(ctx.chat.id, working.message_id, undefined, `${a}\n\n(/abort to stop)`), 2).catch(() => {});
          }
        } catch {}
      }, 2500));
    }
    const out = await fn();
    if (working) await tgCall(() => ctx.deleteMessage(working.message_id)).catch(() => {});
    working = null;
    await replyLong(ctx, out);
  } catch (e) {
    try { if (working) await tgCall(() => ctx.deleteMessage(working.message_id)).catch(() => {}); } catch {}
    await tgCall(() => ctx.reply(`Error: ${e.message}`.slice(0, 4000))).catch(() => {});
  } finally {
    for (const t of keepers) clearInterval(t);
    streaming.clear(key(ctx));
    try { opencode.clearActivity(key(ctx)); } catch {}
  }
}

// Tool policy: block explicit tool commands listed in TOOL_POLICY_DENY.
const deniedTools = new Set((process.env.TOOL_POLICY_DENY || "").split(",").map((s) => s.trim()).filter(Boolean));
bot.use(async (ctx, next) => {
  const cmd = String(ctx.message?.text ?? "").match(/^\/([A-Za-z_]+)/)?.[1];
  if (cmd && deniedTools.has(cmd)) {
    await ctx.reply(`Tool /${cmd} is disabled by TOOL_POLICY_DENY.`, threadExtra(ctx));
    return;
  }
  return next();
});

bot.use(async (ctx, next) => {
  if (!ctx.from) return;
  if (ctx.chat?.id) {
    chatIds.set(String(ctx.from.id), ctx.chat.id);
    threadIds.set(String(ctx.from.id), threadId(ctx));
  }
  // Group chats: mention-based activation (mirrors OpenClaw/Hermes), unless
  // explicitly disabled. Commands and direct replies still work.
  if (ctx.chat?.type && ctx.chat.type !== "private") {
    if (String(process.env.GROUPS_ENABLED ?? "true").toLowerCase() === "false") return;
    const text = String(ctx.message?.text ?? ctx.message?.caption ?? "");
    const mentioned = ctx.me?.username
      ? text.toLowerCase().includes(`@${ctx.me.username.toLowerCase()}`)
      : (ctx.message?.entities ?? []).some((e) => e.type === "mention");
    if (!mentioned && !/^\//.test(text)) return;
  }
  if (!isAllowed(ctx)) {
    // Log sender ID so the owner can add it to ALLOWED_USER_IDS
    console.log(`[auth] unauthorized message from id=${ctx.from.id} username=@${ctx.from.username ?? "?"} text=${String(ctx.message?.text ?? "").slice(0, 80)}`);
    await ctx.reply("Unauthorized. Ask the bot owner to add your ID to ALLOWED_USER_IDS.");
    return;
  }
  return next();
});

ui.register(); // callback buttons — after auth so unauthorized users can't press them

bot.start((ctx) => ui.main(ctx));
bot.command("menu", (ctx) => ui.main(ctx));
bot.help((ctx) => ctx.reply(HELP, Markup.inlineKeyboard([
  [Markup.button.callback("📱 Open interactive menu", "nav:main")],
])));

// ----- sessions -----
bot.command("new", async (ctx) => {
  try {
    const id = await opencode.newSession(key(ctx), arg(ctx) || "telegram");
    await ctx.reply(`New session: ${id}`);
  } catch (e) { await ctx.reply(`Failed: ${e.message}`); }
});
// Last /sessions listing per user — so /use accepts a NUMBER or NAME, not just IDs.
const lastLists = new Map(); // userKey -> [{ id, title }]
const shortId = (id) => String(id ?? "").slice(0, 13) + "…";
function formatSessionList(list) {
  return list
    .map((s, i) => `${i + 1}. "${s.title || "(untitled)"}" (${shortId(s.id)})`)
    .join("\n");
}
bot.command("sessions", async (ctx) => {
  await ui.show(ctx, "sessions");
  const list = ui.get(key(ctx)).lists.sessions ?? [];
  lastLists.set(key(ctx), list.map((s) => ({ id: s.id, title: s.title || "(untitled)" })));
});
bot.command("use", async (ctx) => {
  const q = arg(ctx).trim();
  if (!q) return ctx.reply("Usage: /use <number, name, or id> (see /sessions)");
  // The button menu also populates the session list — fall back to it so
  // tapping Sessions then typing /use 1 keeps working.
  const list = lastLists.get(key(ctx)) ?? (ui.get(key(ctx)).lists.sessions ?? []).map((s) => ({ id: s.id, title: s.title || "(untitled)" }));
  let target = null;
  if (/^\d+$/.test(q)) {
    target = list[Number(q) - 1] ?? null;
    if (!target) return ctx.reply(`No #${q} in the last /sessions list — run /sessions first.`);
  } else {
    const low = q.toLowerCase();
    const hits = list.filter((s) =>
      (s.title || "").toLowerCase().includes(low) ||
      s.id.toLowerCase() === low ||
      s.id.toLowerCase().startsWith(low)
    );
    if (hits.length === 1) target = hits[0];
    else if (hits.length > 1) {
      return ctx.reply(`Multiple match:\n${formatSessionList(hits)}\n/use <number> to pick`);
    }
  }
  if (!target) target = { id: q, title: null }; // raw ID paste — still works
  const st = opencode.switchSession(key(ctx), target);
  await ctx.reply(`Switched to "${st.title || target.id}"`);
});
bot.command("abort", async (ctx) => {
  await ctx.reply((await opencode.abort(key(ctx))) ? "Aborted." : "Nothing to abort.");
});
bot.command("share", async (ctx) => {
  await runAndReply(ctx, "Sharing", async () => fmtJson(await opencode.shareSession(key(ctx))));
});
bot.command("unshare", async (ctx) => {
  await runAndReply(ctx, "Unsharing", async () => fmtJson(await opencode.unshareSession(key(ctx))));
});
bot.command("fork", async (ctx) => {
  await runAndReply(ctx, "Forking", async () => {
    const f = await opencode.forkSession(key(ctx));
    return `Forked: ${f.id ?? fmtJson(f)}`;
  });
});
bot.command("summarize", async (ctx) => {
  await runAndReply(ctx, "Summarizing", async () => "Summarize requested: " + fmtJson(await opencode.summarizeSession(key(ctx))));
});
bot.command("undo", async (ctx) => {
  const id = arg(ctx);
  if (!id) return ctx.reply("Usage: /undo <messageID> (see /messages for IDs)");
  await runAndReply(ctx, "Reverting", async () => fmtJson(await opencode.revertSession(key(ctx), id)));
});
bot.command("diff", async (ctx) => {
  await runAndReply(ctx, "Diffing", async () => fmtJson(await opencode.sessionDiff(key(ctx))), { quiet: true });
});
bot.command("todo", async (ctx) => {
  await runAndReply(ctx, "Todos", async () => fmtJson(await opencode.sessionTodo(key(ctx))), { quiet: true });
});
bot.command("messages", async (ctx) => {
  await runAndReply(ctx, "Messages", async () => {
    const msgs = await opencode.sessionMessages(key(ctx), 8);
    if (!msgs.length) return "No messages yet.";
    return msgs.map((m) => {
      const texts = (m.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join(" | ").slice(0, 300);
      return `• [${m.info?.role}] ${m.info?.id}\n  ${texts}`;
    }).join("\n");
  });
});
bot.command("export", async (ctx) => {
  await runAndReply(ctx, "Exporting", async () => {
    const st = opencode.getState(key(ctx));
    const id = arg(ctx) || st.sessionID;
    if (!id) return "No session yet.";
    return opencode.runCli(["export", id]);
  });
});

// ----- explicit tools -----
bot.command("bash", async (ctx) => {
  const cmd = arg(ctx);
  if (!cmd) return ctx.reply("Usage: /bash <command>");
  await runAndReply(ctx, "Running bash", async () => opencode.useTool(key(ctx), "bash", cmd));
});
bot.command("shell", async (ctx) => {
  const cmd = arg(ctx);
  if (!cmd) return ctx.reply("Usage: /shell <command>");
  await runAndReply(ctx, "Running shell", async () => opencode.runShell(key(ctx), cmd));
});
bot.command("read", async (ctx) => {
  const p = arg(ctx);
  if (!p) return ctx.reply("Usage: /read <path>");
  await runAndReply(ctx, "Reading", async () => opencode.readFile(p), { quiet: true });
});
bot.command("edit", async (ctx) => {
  if (!arg(ctx)) return ctx.reply("Usage: /edit <path> :: <old text> :: <new text>");
  await runAndReply(ctx, "Editing", async () => opencode.useTool(key(ctx), "edit", arg(ctx)));
});
bot.command("write", async (ctx) => {
  if (!arg(ctx)) return ctx.reply("Usage: /write <path> :: <content>");
  await runAndReply(ctx, "Writing", async () => opencode.useTool(key(ctx), "write", arg(ctx)));
});
bot.command("grep", async (ctx) => {
  const q = arg(ctx);
  if (!q) return ctx.reply("Usage: /grep <regex>");
  await runAndReply(ctx, "Searching", async () => fmtJson(await opencode.findText(q)), { quiet: true });
});
bot.command("find", async (ctx) => {
  const q = arg(ctx);
  if (!q) return ctx.reply("Usage: /find <text>");
  await runAndReply(ctx, "Searching", async () => fmtJson(await opencode.findText(q)), { quiet: true });
});
bot.command("glob", async (ctx) => {
  const q = arg(ctx) || "*";
  await runAndReply(ctx, "Finding files", async () => fmtJson(await opencode.findFiles(q)), { quiet: true });
});
bot.command("ls", async (ctx) => {
  await runAndReply(ctx, "Listing", async () => fmtJson(await opencode.listDir(arg(ctx) || ".")), { quiet: true });
});
bot.command("webfetch", async (ctx) => {
  if (!arg(ctx)) return ctx.reply("Usage: /webfetch <url>");
  await runAndReply(ctx, "Fetching", async () => opencode.useTool(key(ctx), "webfetch", arg(ctx)));
});
bot.command("websearch", async (ctx) => {
  if (!arg(ctx)) return ctx.reply("Usage: /websearch <query>");
  await runAndReply(ctx, "Searching web", async () => opencode.useTool(key(ctx), "websearch", arg(ctx)));
});
bot.command("skill", async (ctx) => {
  if (!arg(ctx)) return ctx.reply("Usage: /skill <name>");
  await runAndReply(ctx, "Loading skill", async () => opencode.useTool(key(ctx), "skill", arg(ctx)));
});
bot.command("todoadd", async (ctx) => {
  if (!arg(ctx)) return ctx.reply("Usage: /todoadd <text>");
  await runAndReply(ctx, "Todo", async () => opencode.useTool(key(ctx), "todowrite", arg(ctx)));
});
bot.command("lsp", async (ctx) => {
  if (!arg(ctx)) return ctx.reply("Usage: /lsp <request, e.g. hover src/index.ts:10:5>");
  await runAndReply(ctx, "LSP", async () => opencode.useTool(key(ctx), "lsp", arg(ctx)));
});
bot.command("ask", async (ctx) => {
  if (!arg(ctx)) return ctx.reply("Usage: /ask <topic> — opencode will question you, reply to answer");
  await runAndReply(ctx, "Asking", async () => opencode.useTool(key(ctx), "question", arg(ctx)));
});

// ----- models / agents / system -----
bot.command("model", (ctx) => {
  const m = arg(ctx);
  if (!m || m === "reset") {
    opencode.setModel(key(ctx), "");
    ctx.reply("Model reset to opencode default.");
  } else if (!m.includes("/")) {
    ctx.reply("Use provider/model, e.g. /model anthropic/claude-sonnet-4-5");
  } else {
    opencode.setModel(key(ctx), m);
    ctx.reply(`Model set to ${m} for your chat.`);
  }
});
bot.command("agent", (ctx) => {
  const a = arg(ctx);
  if (!a || a === "reset") {
    opencode.setAgent(key(ctx), "");
    ctx.reply("Agent reset to default.");
  } else {
    opencode.setAgent(key(ctx), a);
    ctx.reply(`Agent set to ${a} for your chat.`);
  }
});
bot.command("models", (ctx) => ui.show(ctx, "models"));
bot.command("providers", (ctx) => ui.show(ctx, "providers"));
bot.command("agents", (ctx) => ui.show(ctx, "agents"));
bot.command("commands", (ctx) => ui.show(ctx, "commands"));
bot.command("tools", (ctx) => ui.show(ctx, "tools"));
bot.command("mcp", async (ctx) => {
  await runAndReply(ctx, "MCP", async () => fmtJson(await opencode.mcpStatus()), { quiet: true });
});
bot.command("lspstatus", async (ctx) => {
  await runAndReply(ctx, "LSP", async () => fmtJson(await opencode.lspStatus()), { quiet: true });
});
bot.command("config", async (ctx) => {
  await runAndReply(ctx, "Config", async () => fmtJson(await opencode.getConfig()), { quiet: true });
});
bot.command("health", async (ctx) => {
  await runAndReply(ctx, "Health", async () => fmtJson(await opencode.health(), 500), { quiet: true });
});
bot.command("status", (ctx) => {
  const st = opencode.getState(key(ctx));
  ctx.reply(`dir: ${process.cwd()}\nsession: "${st.title || "?"}" (${st.sessionID ? shortId(st.sessionID) : "none yet"})\nmodel: ${opencode.getModel(key(ctx))}\nagent: ${st.agent || "(default)"}\nbusy: ${opencode.isBusy(key(ctx))}\n\nTip: /sessions then /use <number or name> to switch.`);
});
bot.command("stats", async (ctx) => {
  await runAndReply(ctx, "Stats", async () => opencode.runCli(["stats"]));
});

// ----- raw CLI parity -----
bot.command("cli", async (ctx) => {
  const raw = arg(ctx);
  if (!raw) return ctx.reply("Usage: /cli <args...> — e.g. /cli models anthropic");
  const parts = raw.split(/\s+/);
  await runAndReply(ctx, `opencode ${parts[0]}`, async () => opencode.runCli(parts));
});
bot.command("run", async (ctx) => {
  if (!arg(ctx)) return ctx.reply("Usage: /run <prompt> — one-shot via agent");
  await runAndReply(ctx, "Running", async () => opencode.prompt(key(ctx), arg(ctx)), { quiet: !streaming.disabled });
});

// ----- permissions: approve/deny from phone -----
bot.command("allow", async (ctx) => {
  const id = arg(ctx);
  if (!id) return ctx.reply("Usage: /allow <permissionID>");
  await runAndReply(ctx, "Allowing", async () => fmtJson(await opencode.answerPermission(key(ctx), id, "allow")));
});
bot.command("deny", async (ctx) => {
  const id = arg(ctx);
  if (!id) return ctx.reply("Usage: /deny <permissionID>");
  await runAndReply(ctx, "Denying", async () => fmtJson(await opencode.answerPermission(key(ctx), id, "deny")));
});

// ----- memory and checkpoints -----
bot.command("remember", (ctx) => {
  const a = arg(ctx);
  if (!a) return ctx.reply("Usage: /remember <fact>", threadExtra(ctx));
  ctx.reply("Remembered: " + memory.remember(a), threadExtra(ctx));
});
bot.command("memory", (ctx) => ctx.reply(memory.load() || "(empty)", threadExtra(ctx)));
bot.command("checkpoint", (ctx) => {
  const id = checkpoints.create(arg(ctx) || "manual");
  ctx.reply(`Checkpoint ${id} (${checkpoints.list().length} total)`, threadExtra(ctx));
});
bot.command("rollback", (ctx) => {
  const id = arg(ctx) || checkpoints.list().sort().slice(-1)[0];
  if (!id) return ctx.reply("No checkpoints.", threadExtra(ctx));
  try { ctx.reply(`Restored ${checkpoints.restore(id)} files from ${id}`, threadExtra(ctx)); }
  catch (e) { ctx.reply(`Rollback failed: ${e.message}`, threadExtra(ctx)); }
});

bot.command("restart", (ctx) => {
  const reply = ctx.reply("🔄 Restarting gateway… (reconnect in a few seconds)", threadExtra(ctx));
  Promise.resolve(reply)
    .catch(() => {})
    .finally(() => scheduleRestart(process.cwd(), opencode));
});

// ----- platform / transport info + toggles -----
bot.command("stream", (ctx) => {
  const a = arg(ctx).toLowerCase();
  if (a === "on" || a === "off") {
    streaming.disabled = a === "off";
    return ctx.reply(`Streaming ${a === "off" ? "disabled" : "enabled"} for this process.`, threadExtra(ctx));
  }
  ctx.reply(`Streaming is ${streaming.disabled ? "off" : "on"}. Use /stream on|off.`, threadExtra(ctx));
});
bot.command("inline", (ctx) => ctx.reply(
  `Inline mode: type @${ctx.me?.username ?? "YourBot"} followed by a question in any Telegram chat.\n` +
  `Enable it once with BotFather /setinline. Optional INLINE_MODEL and INLINE_TIMEOUT_MS.`, threadExtra(ctx)));
bot.command("groups", (ctx) => ctx.reply(
  `Groups: ${String(process.env.GROUPS_ENABLED ?? "true").toLowerCase() === "false" ? "disabled" : "enabled (mention activation)"}\n` +
  `This chat: ${ctx.chat?.type ?? "?"}${threadId(ctx) ? ` · topic ${threadId(ctx)}` : ""}\n` +
  `Sessions are isolated per user, chat and topic.`, threadExtra(ctx)));
bot.command("voice", (ctx) => ctx.reply(
  "Send a voice note and I'll download it and hand it to OpenCode for transcription/analysis. Voice files are attached with their original path.", threadExtra(ctx)));
bot.command("webhook", (ctx) => ctx.reply(
  String(process.env.TELEGRAM_WEBHOOK_ENABLED ?? "").toLowerCase() === "true"
    ? `Webhook mode ON: ${process.env.TELEGRAM_WEBHOOK_URL ?? "(unset)"}`
    : "Webhook mode OFF (long polling). Set TELEGRAM_WEBHOOK_ENABLED=true + TELEGRAM_WEBHOOK_URL to switch.", threadExtra(ctx)));
bot.command("app", (ctx) => {
  const url = process.env.TELEGRAM_MINIAPP_URL;
  if (!url) return ctx.reply("No Mini App configured. Set TELEGRAM_MINIAPP_URL (public HTTPS URL).", threadExtra(ctx));
  ctx.reply("Open the gateway Mini App:", Markup.inlineKeyboard([[Markup.button.webApp("🚀 Open App", url)]]));
});
bot.command("policy", (ctx) => ctx.reply(
  `TOOL_POLICY_DENY: ${process.env.TOOL_POLICY_DENY || "(none)"}\nBlocked commands are refused before reaching the agent.`, threadExtra(ctx)));

// ----- automation, skills and worktrees -----
bot.command("schedule", async (ctx) => {
  const a = arg(ctx);
  if (!a) {
    const jobs = scheduler.list();
    return ctx.reply(jobs.length
      ? jobs.map((j) => `• ${j.id} — every ${j.everyMinutes}m — ${j.prompt}`).join("\n")
      : "No scheduled jobs. Usage: /schedule <minutes> :: <prompt>, or /schedule rm <id>", threadExtra(ctx));
  }
  if (a.startsWith("rm ")) {
    const id = a.slice(3).trim();
    return ctx.reply(scheduler.remove(id) ? `Removed ${id}` : `No job ${id}`, threadExtra(ctx));
  }
  const m = a.match(/^(\d+)\s*::\s*(.+)$/);
  if (!m) return ctx.reply("Usage: /schedule <minutes> :: <prompt>", threadExtra(ctx));
  const job = scheduler.add(m[2], Number(m[1]), ctx.chat?.id, threadId(ctx));
  await ctx.reply(`Scheduled ${job.id} every ${job.everyMinutes}m. /schedule to list, /schedule rm ${job.id} to remove.`, threadExtra(ctx));
});

bot.command("skills", async (ctx) => {
  await runAndReply(ctx, "Skills", async () => {
    const list = await opencode.listSkills();
    return list.length ? list.map((s) => `• /${s.name} — ${s.description}`).join("\n").slice(0, 3800) : "(no skills)";
  });
});

bot.command("worktree", async (ctx) => {
  await runAndReply(ctx, "Worktrees", async () => {
    const a = arg(ctx);
    if (a.startsWith("new ")) return "Created: " + JSON.stringify(await opencode.createWorktree(a.slice(4).trim()));
    if (a.startsWith("rm ")) return "Removed: " + String(await opencode.removeWorktree(a.slice(3).trim()));
    return (await opencode.listWorktrees()).join("\n") || "(no worktrees)";
  });
});

// ----- inline mode: @bot <query> from any chat -----
bot.on("inline_query", async (ctx) => {
  const q = String(ctx.inlineQuery?.query ?? "").trim();
  if (!isAllowed(ctx)) return ctx.answerInlineQuery([], { cache_time: 0 });
  if (!q) {
    return ctx.answerInlineQuery([{
      type: "article", id: "hint", title: "OpenCode inline",
      input_message_content: { message_text: "Type a prompt after @your_bot — requires /setinline in BotFather." },
    }], { cache_time: 0 });
  }
  try {
    const text = await opencode.inlinePrompt(q, { timeoutMs: Number(process.env.INLINE_TIMEOUT_MS || 8000) });
    await ctx.answerInlineQuery([{
      type: "article", id: String(ctx.inlineQuery.id), title: "OpenCode answer",
      description: String(text).slice(0, 100),
      input_message_content: { message_text: String(text).slice(0, 4096) },
    }], { cache_time: 0, is_personal: true });
  } catch {
    await ctx.answerInlineQuery([{
      type: "article", id: "err", title: "OpenCode unavailable",
      input_message_content: { message_text: "OpenCode is busy — try again in a moment." },
    }], { cache_time: 0 });
  }
});

// ----- plain chat = full agent with every tool -----
bot.on("text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  const withRefs = await memory.expand(ctx.message.text, (p) => opencode.readFile(p));
  const withMemory = withRefs + memory.context();
  if (String(process.env.CHECKPOINT_ON_PROMPT ?? "").toLowerCase() === "true") checkpoints.create("auto");
  // With native drafts the draft itself is the progress UI — skip the extra
  // send/edit/delete round-trips that made chat feel slower than the CLI.
  await runAndReply(ctx, "Working", async () => opencode.prompt(key(ctx), withMemory), { quiet: !streaming.disabled });
});

// ----- photos & documents: download -> attach to session -----
const UPLOADS = path.join(process.cwd(), ".telegram-uploads");
try { fs.mkdirSync(UPLOADS, { recursive: true }); } catch {}

async function receiveFile(fileId, fallbackName, caption) {
  let info;
  try {
    info = await telegramApi("getFile", { file_id: fileId });
  } catch (e) {
    throw new Error(`download failed at getFile (Telegram route flaky?): ${scrub(e.message)}`);
  }
  const fpath = info?.result?.file_path;
  if (!fpath) throw new Error(`download failed: Telegram returned no file path (${JSON.stringify(info).slice(0, 150)})`);
  const safe = `${Date.now()}_${String(fileId).slice(-8)}_${path.basename(fallbackName).replace(/[^\w.\-]+/g, "_")}`;
  const dest = path.join(UPLOADS, safe);
  try {
    await downloadTelegramFile(fpath, dest);
  } catch (e) {
    throw new Error(`download failed mid-transfer (route flaky?): ${scrub(e.message)}`);
  }
  let size = 0;
  try { size = fs.statSync(dest).size; } catch {}
  if (!size) {
    try { fs.rmSync(dest, { force: true }); } catch {}
    throw new Error("download failed: received empty file — resend it");
  }
  const text = caption?.trim()
    ? `${caption}\n\n[attached file saved at: ${dest}]`
    : `Work with the attached file saved at: ${dest}`;
  return { dest, text };
}

bot.on("photo", async (ctx) => {
  const photos = ctx.message.photo ?? [];
  if (!photos.length) return;
  const best = photos[photos.length - 1]; // largest
  console.log(`[media] photo from ${key(ctx)}: ${photos.length} sizes, best ${best.width}x${best.height}, caption=${JSON.stringify((ctx.message.caption ?? "").slice(0, 80))}`);
  await runAndReply(ctx, "Receiving photo", async () => {
    const { dest, text } = await receiveFile(best.file_id, "photo.jpg", ctx.message.caption);
    console.log(`[media] photo saved: ${dest}`);
    return opencode.promptWithFiles(key(ctx), text, [{
      mime: "image/jpeg",
      url: pathToFileURL(dest).href,
      filename: path.basename(dest),
    }]);
  });
});

bot.on("voice", async (ctx) => {
  const v = ctx.message.voice;
  if (!v) return;
  await runAndReply(ctx, "Receiving voice note", async () => {
    const { dest, text } = await receiveFile(v.file_id, "voice.ogg", ctx.message.caption);
    return opencode.promptWithFiles(key(ctx), `Transcribe or analyse this voice note: ${text}`, [{
      mime: "audio/ogg", url: pathToFileURL(dest).href, filename: path.basename(dest),
    }]);
  });
});

bot.on("document", async (ctx) => {
  const doc = ctx.message.document;
  if (!doc) return;
  console.log(`[media] document from ${key(ctx)}: name=${doc.file_name} mime=${doc.mime_type} size=${doc.file_size}`);
  if ((doc.file_size ?? 0) > 20 * 1024 * 1024) {
    await ctx.reply("File too large — Bot API caps downloads at 20MB.");
    return;
  }
  await runAndReply(ctx, "Receiving file", async () => {
    const { dest, text } = await receiveFile(doc.file_id, doc.file_name || "file.bin", ctx.message.caption);
    console.log(`[media] document saved: ${dest}`);
    const mime = doc.mime_type || "application/octet-stream";
    // Vision-attach images; other files are referenced by path for the read tool.
    const files = mime.startsWith("image/")
      ? [{ mime, url: pathToFileURL(dest).href, filename: path.basename(dest) }]
      : [];
    return opencode.promptWithFiles(key(ctx), text, files);
  });
});

// ----- push opencode events (permissions, errors) to owner chats -----
// NB: session.idle is deliberately NOT pushed — the reply itself confirms completion.
const ownerIds = [...new Set([
  ...allowed,
  ...(process.env.TELEGRAM_NOTIFY_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),
])];
opencode.onEvent(async (event) => {
  try {
    opencode.noteEventActivity(event); // live "currently doing X" for temp messages
    const type = event?.type ?? event?.event ?? "";
    // v1 uses `properties`, v2 uses `data`; accept both.
    const props = event?.properties ?? event?.data ?? event?.payload ?? {};
    if (/permission\.(asked|updated|v2\.asked)|permission_asked/.test(type)) {
      const pid = props.permissionID ?? props.requestID ?? props.id ?? "?";
      const sessionID = props.sessionID ?? props.session?.id ?? "";
      const tool = typeof props.tool === "string" ? props.tool : (props.permission ?? props.action ?? "");
      const detail = errorMessage(props.request ?? props.message ?? "");
      const text = `Permission needed (${String(sessionID).slice(0, 12)}…): ${tool} ${detail}\n/allow ${pid} or /deny ${pid}`;
      const keyboard = ui.permissionKeyboard(pid, ownerIds);
      for (const id of ownerIds) await tgCall(() => bot.telegram.sendMessage(chatIds.get(id) ?? id, text, { ...(threadIds.get(id) ? { message_thread_id: threadIds.get(id) } : {}), reply_markup: keyboard.reply_markup })).catch(() => {});
    } else if (/question\.(asked|v2\.asked)/.test(type)) {
      const text = `❓ OpenCode has a question:\n${errorMessage(props.question ?? props.text ?? props)}`;
      for (const id of ownerIds) await tgCall(() => bot.telegram.sendMessage(chatIds.get(id) ?? id, text, threadIds.get(id) ? { message_thread_id: threadIds.get(id) } : undefined)).catch(() => {});
    } else if (type === "session.error") {
      const text = `OpenCode error (${String(props.sessionID ?? "").slice(0, 16)}…): ${errorMessage(props.error)}`;
      for (const id of ownerIds) await tgCall(() => bot.telegram.sendMessage(chatIds.get(id) ?? id, text, threadIds.get(id) ? { message_thread_id: threadIds.get(id) } : undefined)).catch(() => {});
    }
  } catch {}
});
try {
  const ctl = new AbortController();
  process.once("SIGINT", () => ctl.abort());
  process.once("SIGTERM", () => ctl.abort());
  opencode.subscribeEvents(ctl.signal).catch(() => {});
} catch {}

bot.catch((err) => console.error("[telegram]", scrub(err?.message ?? err)));
// Last-resort guards so a token URL can never hit disk raw again.
process.on("unhandledRejection", (e) => console.error("[rejected]", scrub(e?.stack ?? String(e))));
process.on("uncaughtException", (e) => { console.error("[fatal]", scrub(e?.stack ?? String(e))); process.exit(1); });
process.once("SIGINT", () => { bot.stop("SIGINT"); opencode.close().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { bot.stop("SIGTERM"); opencode.close().finally(() => process.exit(0)); });

// Retry launch forever: a VPN flap / blocked route at boot must not kill the bot.
// Order: saved pin (instant) -> re-resolve (quick list -> full subnet sweep) on
// every 3rd failure, so even fully-blacklisted networks heal without a restart.
async function launchWithRetry(attempt = 1) {
  let net = null;
  try { net = await import("./net.js"); } catch {}
  // Trust the saved pin first — one getMe, no scanning, instant start.
  if (attempt === 1 && net?.resolveWithSavedPin && process.env.TELEGRAM_API_IP) {
    const quick = await net.resolveWithSavedPin(TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_API_IP.trim());
    if (quick) console.log(`[net] saved endpoint ${process.env.TELEGRAM_API_IP.trim()} verified — using it.`);
    else console.log("[net] saved endpoint dead — re-scanning…");
  }

  const onFailure = (e) => {
    const wait = Math.min(15000 * attempt, 120000);
    console.error(`[telegram] launch failed (attempt ${attempt}): ${scrub(e?.message ?? e)}. Retrying in ${wait / 1000}s…`);
    if (net && attempt % 3 === 0) {
      net.resolveTelegramRoute(TELEGRAM_BOT_TOKEN).then((v) => {
        if (v.bot) {
          if (v.pin) process.env.TELEGRAM_API_IP = v.pin;
          else delete process.env.TELEGRAM_API_IP;
          console.log(`[telegram] route re-resolved: ${v.mode}${v.pin ? ` (${v.pin})` : ""}`);
        } else {
          console.log(`[telegram] still unreachable: ${v.diagnosis.join(" | ").slice(0, 300)}`);
        }
      }).catch(() => {});
    }
    setTimeout(() => { launchWithRetry(attempt + 1).catch(() => {}); }, wait);
  };

  try {
    // Telegraf's launch() promise lives as long as long polling does — it does
    // NOT resolve on success. Report online once polling has been started, and
    // only use the rejection path for real failures.
    if (String(process.env.TELEGRAM_WEBHOOK_ENABLED ?? "").toLowerCase() === "true") {
      const domain = process.env.TELEGRAM_WEBHOOK_URL ?? "";
      if (!domain) throw new Error("TELEGRAM_WEBHOOK_URL is required for webhook mode");
      const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET || undefined;
      await tgCall(() => bot.telegram.setWebhook(domain, {
        secret_token: secretToken, drop_pending_updates: true,
      }));
      bot.launch({
        webhook: {
          domain,
          path: new URL(domain).pathname || "/",
          host: process.env.TELEGRAM_WEBHOOK_HOST || "0.0.0.0",
          port: Number(process.env.TELEGRAM_WEBHOOK_PORT || 8443),
          secretToken,
        },
      }).catch(onFailure);
      console.log(`[telegram] webhook gateway online in ${bootSecs()} at ${domain}`);
    } else {
      bot.launch().catch(onFailure);
      console.log(`[telegram] gateway online in ${bootSecs()}. Send /start in Telegram.`);
    }
  } catch (e) {
    onFailure(e);
  }
}
await launchWithRetry();
