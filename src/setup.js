// Interactive setup wizard — launched by `opencode gateway setup`
// (shell wrapper forwards `gateway ...` to the `opencode-gateway` binary).
//
// Walks through 7 steps: bot token → connection check → allowed users →
// project folder → model/port → review → save. Re-runs keep existing values
// as defaults. Fully scriptable with flags + --yes. Zero dependencies.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { readEnv, writeEnv } from "./daemon.js";

// ---------- tiny terminal UI (zero deps) ----------
let rl = null;
function ensureRl() {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}
export function closeRl() {
  try { rl?.close(); } catch {}
  rl = null;
}
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
};
export const ok = (m) => console.log(`${C.green}✓${C.reset} ${m}`);
export const warn = (m) => console.log(`${C.yellow}!${C.reset} ${m}`);
export const err = (m) => console.log(`${C.red}✗${C.reset} ${m}`);
export const info = (m) => console.log(`  ${C.dim}${m}${C.reset}`);
const stepHead = (n, total, title) =>
  console.log(`\n${C.bold}${C.cyan}[${n}/${total}]${C.reset}${C.bold} ${title}${C.reset}`);

function ask(q, def = "") {
  const r = ensureRl();
  const hint = def ? ` ${C.dim}[${def}]${C.reset}` : "";
  return new Promise((res) =>
    r.question(`  ${C.cyan}?${C.reset} ${q}${hint}: `, (a) => res(a.trim() || def))
  );
}
function askSecret(q, keepHint = "") {
  // Truly hidden input: terminal echo off while typing (POSIX). Falls back to
  // plain input where echo can't be controlled — never the fake-masking that
  // would also swallow the prompt text itself.
  const r = ensureRl();
  const hint = keepHint ? ` ${C.dim}${keepHint}${C.reset}` : "";
  const prompt = `  ${C.cyan}?${C.reset} ${q}${hint}: `;
  if (!process.stdin.isTTY || process.platform === "win32") {
    if (process.platform === "win32" && process.stdin.isTTY) {
      info("(this terminal can't hide input — your token will be visible while typing)");
    }
    return new Promise((res) => r.question(prompt, (a) => res(a.trim())));
  }
  return new Promise((res) => {
    spawnSync("stty", ["-echo"], { stdio: "inherit" });
    r.question(prompt, (a) => {
      spawnSync("stty", ["echo"], { stdio: "inherit" });
      r.output.write("\n");
      res(a.trim());
    });
  });
}
async function askYesNo(q, defYes = true) {
  const hint = defYes ? "Y/n" : "y/N";
  const a = (await ask(`${q} (${hint})`)).toLowerCase();
  if (!a) return defYes;
  return ["y", "yes"].includes(a);
}

// Simple spinner while a promise runs (network checks can take a while).
async function withSpinner(label, promise) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const t = setInterval(() => {
    process.stdout.write(`\r  ${C.cyan}${frames[i++ % frames.length]}${C.reset} ${label}…`);
  }, 90);
  try {
    return await promise;
  } finally {
    clearInterval(t);
    process.stdout.write("\r" + " ".repeat(label.length + 8) + "\r");
  }
}

const maskToken = (t) =>
  !t ? "(not set)" : t.length <= 8 ? "****" : `${t.slice(0, 4)}…${t.slice(-4)}`;
const validUserIds = (s) =>
  String(s).split(",").map((x) => x.trim()).filter(Boolean)
    .every((x) => /^\d+$/.test(x));

// ---------- /start auto-detect ----------
async function detectUserId(pkgRoot, token, pin, waitMs = 60000) {
  const { telegramApi } = await import(path.join(pkgRoot, "src", "net.js"));
  const prevToken = process.env.TELEGRAM_BOT_TOKEN;
  const prevPin = process.env.TELEGRAM_API_IP;
  process.env.TELEGRAM_BOT_TOKEN = token;
  if (pin) process.env.TELEGRAM_API_IP = pin;
  try {
    console.log(`  ${C.dim}Send /start to your bot from YOUR Telegram account (waiting 60s)…${C.reset}`);
    let offset = 0;
    const end = Date.now() + waitMs;
    while (Date.now() < end) {
      try {
        const r = await telegramApi("getUpdates", { offset, timeout: 10 });
        for (const u of r.result || []) {
          offset = u.update_id + 1;
          const from = u.message?.from || u.edited_message?.from;
          if (from?.id && !from.is_bot) return String(from.id);
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
    warn("No message seen — enter the ID manually.");
    return "";
  } finally {
    if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = prevToken;
    if (prevPin === undefined) delete process.env.TELEGRAM_API_IP;
    else process.env.TELEGRAM_API_IP = prevPin;
  }
}

function installPlugin(userIds) {
  try {
    const cfgPath = path.join(os.homedir(), ".config", "opencode", "opencode.json");
    if (!fs.existsSync(cfgPath)) { warn(`OpenCode config not found at ${cfgPath} — skipping plugin.`); return; }
    const bak = cfgPath + ".bak-gateway";
    if (!fs.existsSync(bak)) fs.copyFileSync(cfgPath, bak);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.plugin = cfg.plugin || [];
    if (!cfg.plugin.includes("opencode-telegram-gateway")) cfg.plugin.push("opencode-telegram-gateway");
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    ok(`Plugin added to ${cfgPath} (backup: ${bak}). Set TELEGRAM_NOTIFY_CHAT_IDS=${userIds} where opencode runs.`);
  } catch (e) { warn(`Plugin install skipped: ${e.message}`); }
}

// ---------- the wizard ----------
export async function runSetup({ flags, dir, pkgRoot }) {
  console.log(`\n${C.bold}📱 opencode-gateway setup${C.reset} — Telegram remote for OpenCode\n`);
  const env = readEnv(dir);
  const hadEnv = Object.keys(env).length > 0;
  if (hadEnv) info(`Found existing config in ${dir} — current values are the defaults, Enter keeps them.\n`);

  // Earlier setup choices (custom root / proxy) participate in all checks below.
  if (env.TELEGRAM_API_ROOT && !process.env.TELEGRAM_API_ROOT) process.env.TELEGRAM_API_ROOT = env.TELEGRAM_API_ROOT;
  if (env.HTTPS_PROXY && !process.env.HTTPS_PROXY && !process.env.https_proxy) process.env.HTTPS_PROXY = env.HTTPS_PROXY;

  const nonInteractive = !!flags.yes;
  const skipChecks = !!flags["skip-checks"];
  if (!process.stdin.isTTY && !nonInteractive && !flags.token) {
    err("No TTY and no --token: re-run with --yes plus --token/--user-id/--work-dir, or run interactively.");
    process.exit(1);
  }
  const TOTAL = 7;

  // ---- 1. bot token ----
  stepHead(1, TOTAL, "Bot token");
  info("Telegram → @BotFather → /newbot → copy the token. It stays in local .env, never printed.\n");
  let token = flags.token || env.TELEGRAM_BOT_TOKEN || "";
  if (!token || (!nonInteractive && process.stdin.isTTY && !flags.token)) {
    const keep = token ? `Enter keeps ${maskToken(token)}` : "";
    const t = await askSecret("Bot token (input hidden)", keep);
    if (t) token = t; // empty keeps the existing one
  }
  const tokenLooksOk = /^\d+:[\w-]{20,}$/.test(token);
  if (!token) { err("Bot token is required."); process.exit(1); }
  // Format is validated locally even with --skip-checks (that flag only skips network).
  if (!tokenLooksOk && (!skipChecks || nonInteractive)) {
    warn("That doesn't look like a BotFather token (expected 123456:ABC-def…).");
    if (nonInteractive) process.exit(1);
    if (!(await askYesNo("Use it anyway", false))) process.exit(0);
  }

  // ---- 2. reachability ----
  let pin = env.TELEGRAM_API_IP || "";
  let botName = "";
  if (!skipChecks) {
    stepHead(2, TOTAL, "Connection to Telegram");
    const { resolveTelegramRoute } = await import(path.join(pkgRoot, "src", "net.js"));
    const verdict = await withSpinner(
      "Trying direct route, then fallback endpoints",
      resolveTelegramRoute(token)
    );
    if (verdict.bot) {
      botName = verdict.bot.username ? `@${verdict.bot.username}` : "";
      pin = verdict.pin;
      const how = {
        direct: "direct route works",
        pinned: `via verified endpoint ${pin}`,
        proxy: "via proxy",
        "custom-root": "via custom API root",
      }[verdict.mode];
      ok(`Bot found: ${botName || "(no username yet — set one in @BotFather)"} (${how}).`);
    } else if (verdict.diagnosis.some((d) => d.includes("rejected"))) {
      err("Telegram rejected the token (invalid or revoked). Get a fresh one from @BotFather.");
      process.exit(1);
    } else {
      warn("No route to Telegram from here:");
      for (const d of verdict.diagnosis) info(`  • ${d}`);
      if (!nonInteractive && process.stdin.isTTY) {
        const px = await ask("HTTPS proxy URL (empty to skip — a VPN also works)", env.HTTPS_PROXY || "");
        if (px) {
          process.env.HTTPS_PROXY = px;
          env.HTTPS_PROXY = px;
          const retry = await withSpinner("Retrying through the proxy", resolveTelegramRoute(token));
          if (retry.bot) {
            botName = retry.bot.username ? `@${retry.bot.username}` : "";
            ok(`Bot found: ${botName} (via proxy).`);
          } else warn("Proxy didn't help either — continuing, will verify at start.");
        }
      }
      if (!nonInteractive && !(await askYesNo("Continue setup anyway", true))) process.exit(0);
    }
  }

  // ---- 3. allowed users ----
  stepHead(3, TOTAL, "Who may use the bot");
  info("Only these Telegram IDs can run code on this machine. From @userinfobot.\n");
  let userIds = flags["user-id"] || env.ALLOWED_USER_IDS || "";
  const canDetect = !userIds && !skipChecks && process.stdin.isTTY && !nonInteractive && tokenLooksOk;
  if (canDetect) {
    info("Easiest: send /start to your bot and I'll detect your ID automatically.");
    if (await askYesNo("Auto-detect my Telegram ID now", true)) {
      userIds = await detectUserId(pkgRoot, token, pin);
      if (userIds) ok(`Detected your Telegram ID: ${userIds}`);
    }
  }
  for (;;) {
    if (!userIds) {
      userIds = nonInteractive ? "" : await ask("Your Telegram user ID(s), comma-separated");
    }
    if (!userIds) {
      if (nonInteractive) { err("--user-id is required (or leave truly open — not recommended)."); process.exit(1); }
      warn("Empty = ANY Telegram user who finds the bot can run code here.");
      if (await askYesNo("Leave open to everyone", false)) break;
      userIds = "";
      continue;
    }
    if (!validUserIds(userIds)) {
      err("IDs must be numeric (comma-separated).");
      if (nonInteractive) process.exit(1);
      userIds = "";
      continue;
    }
    break;
  }

  // ---- 4. project folder ----
  stepHead(4, TOTAL, "Project folder");
  let workDir = flags["work-dir"] || env.WORK_DIR || process.cwd();
  if (!nonInteractive && process.stdin.isTTY && !flags["work-dir"]) {
    workDir = await ask("Folder OpenCode works in (WORK_DIR)", workDir);
  }
  for (;;) {
    if (fs.existsSync(workDir)) break;
    err(`Folder does not exist: ${workDir}`);
    if (nonInteractive) process.exit(1);
    if (await askYesNo("Create it", true)) {
      fs.mkdirSync(workDir, { recursive: true });
      ok(`Created ${workDir}`);
      break;
    }
    workDir = await ask("Folder OpenCode works in (WORK_DIR)", process.cwd());
  }

  // ---- 5. model & port ----
  stepHead(5, TOTAL, "Model & port");
  let model = flags.model !== undefined ? flags.model : env.OPENCODE_MODEL || "";
  let agent = flags.agent !== undefined ? flags.agent : env.OPENCODE_AGENT || "";
  let port = String(flags.port || env.OPENCODE_PORT || "4096");
  if (!nonInteractive && process.stdin.isTTY) {
    if (flags.model === undefined) {
      model = await ask("Default model provider/model (empty = server default)", model);
      while (model && !model.includes("/")) {
        err("Use provider/model format, e.g. anthropic/claude-sonnet-4-5.");
        model = await ask("Default model provider/model (empty = server default)", "");
      }
    }
    if (flags.agent === undefined) agent = await ask("Default agent (empty = opencode default)", agent);
    port = await ask("Gateway port", port);
    while (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      err("Port must be 1–65535.");
      port = await ask("Gateway port", "4096");
    }
  } else {
    if (model && !model.includes("/")) { err("Model must be provider/model format."); process.exit(1); }
    if (!/^\d+$/.test(port)) { err("Port must be numeric."); process.exit(1); }
  }

  // ---- 6. review ----
  const cfg = {
    TELEGRAM_BOT_TOKEN: token,
    ALLOWED_USER_IDS: userIds,
    TELEGRAM_NOTIFY_CHAT_IDS: userIds,
    WORK_DIR: workDir,
    OPENCODE_PORT: port,
    OPENCODE_HOSTNAME: env.OPENCODE_HOSTNAME || "127.0.0.1",
    OPENCODE_MODEL: model,
    OPENCODE_AGENT: agent,
    CLI_ENABLED: env.CLI_ENABLED || "true",
    TELEGRAM_API_IP: pin,
    HTTPS_PROXY: env.HTTPS_PROXY || "",
    TELEGRAM_API_ROOT: env.TELEGRAM_API_ROOT || "",
  };
  if (!nonInteractive && process.stdin.isTTY) {
    for (;;) {
      stepHead(6, TOTAL, "Review");
      const rows = [
        ["1", "Bot token", maskToken(token)],
        ["2", "Allowed user IDs", userIds],
        ["3", "Project folder", workDir],
        ["4", "Model", model || "(server default)"],
        ["5", "Agent", agent || "(opencode default)"],
        ["6", "Port", port],
        ["7", "Telegram route", pin ? `pinned endpoint ${pin}` : env.HTTPS_PROXY ? "proxy" : "direct"],
      ];
      for (const [n, k, v] of rows) console.log(`  ${C.dim}${n}.${C.reset} ${k.padEnd(18)} ${C.bold}${v}${C.reset}`);
      const choice = (await ask("\nSave this? (Enter = yes, number = edit that field, q = quit)")).toLowerCase();
      if (!choice || choice === "y" || choice === "yes") break;
      if (choice === "q" || choice === "quit") { info("Aborted — nothing written."); process.exit(0); }
      if (choice === "1") {
        const t = await askSecret("Bot token (input hidden)", `Enter keeps ${maskToken(token)}`);
        if (t) { cfg.TELEGRAM_BOT_TOKEN = t; token = t; }
      }
      else if (choice === "2") {
        const u = await ask("Allowed user ID(s)", userIds);
        if (!validUserIds(u)) { err("IDs must be numeric — kept old value."); continue; }
        cfg.ALLOWED_USER_IDS = u; cfg.TELEGRAM_NOTIFY_CHAT_IDS = u; userIds = u;
      }
      else if (choice === "3") {
        const w = await ask("Project folder", workDir);
        if (!fs.existsSync(w)) { err(`Folder does not exist: ${w} — kept old value.`); continue; }
        cfg.WORK_DIR = w; workDir = w;
      }
      else if (choice === "4") {
        const m = await ask("Default model (empty = server default)", model);
        if (m && !m.includes("/")) { err("Use provider/model format — kept old value."); continue; }
        cfg.OPENCODE_MODEL = m; model = m;
      }
      else if (choice === "5") { cfg.OPENCODE_AGENT = await ask("Default agent", agent); agent = cfg.OPENCODE_AGENT; }
      else if (choice === "6") {
        const p = await ask("Gateway port", port);
        if (!/^\d+$/.test(p)) { err("Port must be numeric — kept old value."); continue; }
        cfg.OPENCODE_PORT = p; port = p;
      }
      else if (choice === "7") { warn("Route is auto-detected — re-run setup to re-check the network."); }
      else warn("Unknown choice — Enter saves, 1–6 edits, q quits.");
    }
  }

  // ---- 7. save + menu + plugin ----
  stepHead(7, TOTAL, "Save & finish");
  writeEnv(dir, cfg);
  ok(`Saved ${path.join(dir, ".env")} (token stays secret, never commit).`);

  if (botName && !flags["no-menu"]) {
    try {
      const { COMMANDS } = await import(path.join(pkgRoot, "src", "commands.js"));
      const { telegramApi } = await import(path.join(pkgRoot, "src", "net.js"));
      const prev = {
        token: process.env.TELEGRAM_BOT_TOKEN,
        pin: process.env.TELEGRAM_API_IP,
        root: process.env.TELEGRAM_API_ROOT,
        proxy: process.env.HTTPS_PROXY,
      };
      process.env.TELEGRAM_BOT_TOKEN = token;
      if (pin) process.env.TELEGRAM_API_IP = pin;
      if (cfg.TELEGRAM_API_ROOT) process.env.TELEGRAM_API_ROOT = cfg.TELEGRAM_API_ROOT;
      if (cfg.HTTPS_PROXY) process.env.HTTPS_PROXY = cfg.HTTPS_PROXY;
      try {
        const r = await telegramApi("setMyCommands", { commands: COMMANDS.map(([command, description]) => ({ command, description })) });
        if (r.ok) ok("Published the Menu ☰ button with all commands.");
        else warn("Menu publish failed (bot still works, use /help).");
      } finally {
        if (prev.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
        else process.env.TELEGRAM_BOT_TOKEN = prev.token;
        if (prev.pin === undefined) delete process.env.TELEGRAM_API_IP;
        else process.env.TELEGRAM_API_IP = prev.pin;
        if (prev.root === undefined) delete process.env.TELEGRAM_API_ROOT;
        else process.env.TELEGRAM_API_ROOT = prev.root;
        if (prev.proxy === undefined) delete process.env.HTTPS_PROXY;
        else process.env.HTTPS_PROXY = prev.proxy;
      }
    } catch (e) { warn(`Menu publish skipped: ${e.message}`); }
  }

  let wantPlugin = false;
  if (!nonInteractive && process.stdin.isTTY) {
    wantPlugin = await askYesNo("Also install the OpenCode plugin (push alerts to Telegram)", true);
    if (wantPlugin) installPlugin(userIds);
  }

  console.log(`\n${C.bold}${C.green}Done.${C.reset}${C.bold} Your phone is now a remote for ${workDir}${C.reset}`);
  if (botName) console.log(`  ${C.cyan}→${C.reset} Open Telegram and send /start to ${C.bold}${botName}${C.reset} (https://t.me/${botName.slice(1)})`);
  else console.log(`  ${C.cyan}→${C.reset} Open Telegram and send /start to your bot.`);
  console.log(`\n  Start it with:\n\n    ${C.bold}opencode gateway start${C.reset}\n`);

  if (!nonInteractive && process.stdin.isTTY) {
    return await askYesNo("Start the gateway now", true);
  }
  return false;
}
