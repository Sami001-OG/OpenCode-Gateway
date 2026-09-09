#!/usr/bin/env node
// opencode-gateway — setup wizard + daemon control for the Telegram gateway.
//
//   opencode-gateway setup            interactive terminal UI (bot token, user id, ...)
//   opencode-gateway setup --token X --user-id Y --work-dir Z --yes [--skip-checks]
//   opencode-gateway start [--dir DIR]
//   opencode-gateway stop [--dir DIR]
//   opencode-gateway restart [--dir DIR]
//   opencode-gateway status [--dir DIR]
//   opencode-gateway logs [--dir DIR] [-n 60]
//
// Want the exact spelling `opencode gateway start`? Add the wrapper from README
// (a 3-line shell function that forwards `gateway ...` here, everything else to opencode).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import readline from "node:readline";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GATEWAY_ENTRY = path.join(PKG_ROOT, "src", "index.js");
const PID_FILE = ".gateway.pid";
const LOG_FILE = "gateway.log";
const ERR_FILE = "gateway.err.log";

const args = process.argv.slice(2);
const cmd = args[0];
const flags = {};
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) {
    const k = a.slice(2);
    const v = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
    flags[k] = v;
  }
}
const DIR = path.resolve(flags.dir || process.cwd());
const ENV_FILE = path.join(DIR, ".env");

// ---------- tiny terminal UI (zero deps) ----------
let rl = null;
function ensureRl() {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}
function ask(q, def = "") {
  const r = ensureRl();
  const hint = def ? ` [${def}]` : "";
  return new Promise((res) => r.question(`\x1b[36m? \x1b[0m${q}${hint}: `, (a) => res(a.trim() || def)));
}
function askSecret(q) {
  // Muted input; falls back to plain when stdin isn't a TTY (pipes).
  if (!process.stdin.isTTY) return ask(q);
  const r = ensureRl();
  return new Promise((res) => {
    const orig = r._writeToOutput;
    r._writeToOutput = function (s) {
      if (/[\r\n]/.test(s)) r.output.write(s);
      else r.output.write("*");
    };
    r.question(`\x1b[36m? \x1b[0m${q}: `, (a) => {
      r._writeToOutput = orig;
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
const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`\x1b[33m!\x1b[0m ${m}`);
const info = (m) => console.log(`  ${m}`);
const banner = () => console.log("\n\x1b[1m📱 opencode-gateway setup\x1b[0m — Telegram remote for OpenCode\n");

// ---------- .env helpers (never prints secrets) ----------
function readEnv() {
  const out = {};
  if (!fs.existsSync(ENV_FILE)) return out;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
function writeEnv(obj) {
  const keys = [
    "TELEGRAM_BOT_TOKEN", "ALLOWED_USER_IDS", "TELEGRAM_NOTIFY_CHAT_IDS",
    "WORK_DIR", "OPENCODE_SERVER_URL", "OPENCODE_HOSTNAME", "OPENCODE_PORT",
    "OPENCODE_MODEL", "OPENCODE_AGENT", "CLI_ENABLED", "TELEGRAM_API_IP", "HTTPS_PROXY",
    "TELEGRAM_API_ROOT",
  ];
  const lines = ["# Managed by `opencode-gateway setup` - secrets stay here, never commit."];
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== "") lines.push(`${k}=${obj[k]}`);
  for (const k of Object.keys(obj)) if (!keys.includes(k) && obj[k] !== "") lines.push(`${k}=${obj[k]}`);
  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n");
}

// ---------- network checks (lazy imports so --help stays instant) ----------
async function net() {
  return import(path.join(PKG_ROOT, "src", "net.js"));
}

// ---------- setup wizard ----------
async function setup() {
  banner();
  const env = readEnv();
  // Earlier setup choices (custom root / proxy) participate in all checks below.
  if (env.TELEGRAM_API_ROOT && !process.env.TELEGRAM_API_ROOT) process.env.TELEGRAM_API_ROOT = env.TELEGRAM_API_ROOT;
  if (env.HTTPS_PROXY && !process.env.HTTPS_PROXY && !process.env.https_proxy) process.env.HTTPS_PROXY = env.HTTPS_PROXY;
  const nonInteractive = !!flags.yes;
  if (!process.stdin.isTTY && !nonInteractive && !flags.token) {
    console.error("No TTY and no --token: re-run with --yes plus --token/--user-id/--work-dir, or run interactively.");
    process.exit(1);
  }

  // 1. bot token
  let token = flags.token || env.TELEGRAM_BOT_TOKEN || "";
  if (!token) {
    info("Talk to @BotFather on Telegram → /newbot → copy the token.\n");
    token = await askSecret("Bot token (input hidden)");
  }
  if (!token) { console.error("Bot token is required."); process.exit(1); }

  // 2. reachability: direct -> pinned DC -> proxy -> clear diagnosis (automatic)
  let pin = env.TELEGRAM_API_IP || "";
  let me = null;
  if (!flags["skip-checks"]) {
    info("Checking route to Telegram (direct → fallback endpoints)…");
    const { resolveTelegramRoute } = await net();
    // A custom root or proxy from an earlier setup participates automatically.
    if (env.TELEGRAM_API_ROOT) process.env.TELEGRAM_API_ROOT = env.TELEGRAM_API_ROOT;
    if (env.HTTPS_PROXY) { process.env.HTTPS_PROXY = env.HTTPS_PROXY; }
    const verdict = await resolveTelegramRoute(token);
    if (verdict.bot) {
      me = { ok: true, result: verdict.bot };
      pin = verdict.pin;
      const how = { direct: "direct route works", pinned: `via verified endpoint ${pin}`, proxy: "via proxy", "custom-root": "via custom API root" }[verdict.mode];
      ok(`Bot found: @${verdict.bot.username} (${how}).`);
    } else if (verdict.diagnosis.some((d) => d.includes("rejected"))) {
      warn("Telegram rejected the token (invalid or revoked). Get a fresh one from @BotFather.");
      if (!nonInteractive && !(await askYesNo("Continue anyway", false))) process.exit(0);
    } else {
      warn("No route to Telegram from here:");
      for (const d of verdict.diagnosis) info(`  • ${d}`);
      if (!nonInteractive && process.stdin.isTTY) {
        const px = await ask("HTTPS proxy URL (empty to skip — VPN also works)", env.HTTPS_PROXY || "");
        if (px) {
          process.env.HTTPS_PROXY = px;
          env.HTTPS_PROXY = px;
          const retry = await resolveTelegramRoute(token);
          if (retry.bot) {
            me = { ok: true, result: retry.bot };
            ok(`Bot found: @${retry.bot.username} (via proxy).`);
          } else warn("Proxy didn't help either — continuing, will verify at start.");
        }
      }
      if (!me && !nonInteractive && !(await askYesNo("Continue setup anyway", true))) process.exit(0);
    }
  }

  // 3. user id: auto-detect via /start, else manual
  let userId = flags["user-id"] || env.ALLOWED_USER_IDS || "";
  if (!userId && !flags["skip-checks"] && me?.ok && process.stdin.isTTY && !nonInteractive) {
    info(`Now send /start to @${me.result.username} from YOUR Telegram account…`);
    userId = await detectUserId(token, pin);
    if (userId) ok(`Detected your Telegram ID: ${userId}`);
  }
  if (!userId) {
    info("Get your numeric ID from @userinfobot on Telegram.\n");
    userId = await ask("Your Telegram user ID");
  }
  if (!/^\d+$/.test(userId)) { console.error("User ID must be numeric."); process.exit(1); }

  // 4. work dir + model + port
  let workDir = flags["work-dir"] || env.WORK_DIR || process.cwd();
  if (!nonInteractive && process.stdin.isTTY) workDir = await ask("Project folder OpenCode works in (WORK_DIR)", workDir);
  if (!fs.existsSync(workDir)) { console.error(`Folder does not exist: ${workDir}`); process.exit(1); }
  let model = flags.model !== undefined ? flags.model : env.OPENCODE_MODEL || "";
  if (!nonInteractive && process.stdin.isTTY && !flags.model) {
    model = await ask("Default model provider/model (empty = server default)", model);
    if (model && !model.includes("/")) { console.error("Use provider/model format."); process.exit(1); }
  }
  const port = flags.port || env.OPENCODE_PORT || "4096";

  // 5. write .env
  writeEnv({
    ...env,
    TELEGRAM_BOT_TOKEN: token,
    ALLOWED_USER_IDS: userId,
    TELEGRAM_NOTIFY_CHAT_IDS: userId,
    WORK_DIR: workDir,
    OPENCODE_PORT: String(port),
    OPENCODE_MODEL: model,
    OPENCODE_HOSTNAME: env.OPENCODE_HOSTNAME || "127.0.0.1",
    CLI_ENABLED: env.CLI_ENABLED || "true",
    TELEGRAM_API_IP: pin,
    HTTPS_PROXY: env.HTTPS_PROXY || "",
    TELEGRAM_API_ROOT: env.TELEGRAM_API_ROOT || "",
  });
  ok(`Saved ${ENV_FILE} (token stays secret, never commit).`);

  // 6. publish command menu
  if (!flags["no-menu"] && me?.ok) {
    try {
      const { COMMANDS } = await import(path.join(PKG_ROOT, "src", "commands.js"));
      process.env.TELEGRAM_BOT_TOKEN = token;
      if (pin) process.env.TELEGRAM_API_IP = pin;
      if (env.TELEGRAM_API_ROOT) process.env.TELEGRAM_API_ROOT = env.TELEGRAM_API_ROOT;
      if (env.HTTPS_PROXY) process.env.HTTPS_PROXY = env.HTTPS_PROXY;
      const { telegramApi } = await net();
      const r = await telegramApi("setMyCommands", { commands: COMMANDS.map(([command, description]) => ({ command, description })) });
      if (r.ok) ok("Published the Menu ☰ button with all commands.");
      else warn("Menu publish failed (bot still works, use /help).");
    } catch (e) { warn(`Menu publish skipped: ${e.message}`); }
  }

  // 7. optional opencode plugin (push notifications)
  const wantPlugin = nonInteractive ? false : (process.stdin.isTTY ? await askYesNo("Also install the OpenCode plugin (push alerts to Telegram)", true) : false);
  if (wantPlugin) installPlugin(token, userId);

  console.log("\n\x1b[1mDone.\x1b[0m Start it with:\n");
  console.log("  opencode-gateway start\n");
  rl?.close();
}

async function detectUserId(token, pin, waitMs = 60000) {
  // Poll getUpdates for any message; the sender is (almost certainly) the owner.
  const { telegramApi } = await net();
  process.env.TELEGRAM_BOT_TOKEN = token;
  if (pin) process.env.TELEGRAM_API_IP = pin;
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
}

function installPlugin(token, userId) {
  try {
    const cfgPath = process.platform === "win32"
      ? path.join(os.homedir(), ".config", "opencode", "opencode.json")
      : path.join(os.homedir(), ".config", "opencode", "opencode.json");
    if (!fs.existsSync(cfgPath)) { warn(`OpenCode config not found at ${cfgPath} — skipping plugin.`); return; }
    const bak = cfgPath + ".bak-gateway";
    if (!fs.existsSync(bak)) fs.copyFileSync(cfgPath, bak);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.plugin = cfg.plugin || [];
    if (!cfg.plugin.includes("opencode-telegram-gateway")) cfg.plugin.push("opencode-telegram-gateway");
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    ok(`Plugin added to ${cfgPath} (backup: ${bak}). Set TELEGRAM_NOTIFY_CHAT_IDS=${userId} where opencode runs.`);
  } catch (e) { warn(`Plugin install skipped: ${e.message}`); }
}

// ---------- daemon control ----------
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function readPid(dir) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, PID_FILE), "utf8"));
    if (!pidAlive(p.pid)) return null;
    // Guard against PID reuse: make sure it's really our gateway process.
    try {
      let cmd = "";
      if (process.platform === "win32") {
        cmd = execSync(
          `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${p.pid}').CommandLine"`,
          { encoding: "utf8", timeout: 15000 }
        );
      } else {
        cmd = fs.readFileSync(`/proc/${p.pid}/cmdline`, "utf8").replace(/\0/g, " ");
      }
      if (!/index\.js|opencode-gateway|src.cli/i.test(cmd)) return null;
    } catch { return null; }
    return p.pid;
  } catch { return null; }
}
function portOwner(port) {
  // Windows + unix best-effort listener lookup
  try {
    if (process.platform === "win32") {
      const out = execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Listen' } | Select-Object -ExpandProperty OwningProcess"`,
        { encoding: "utf8", timeout: 15000 }
      ).trim().split(/\s+/).filter(Boolean);
      return out.length ? Number(out[0]) : null;
    }
    const out = execSync(`lsof -ti tcp:${port} 2>/dev/null || true`, { encoding: "utf8", timeout: 15000 }).trim();
    return out ? Number(out.split("\n")[0]) : null;
  } catch { return null; }
}
function procName(pid) {
  try {
    if (process.platform === "win32") {
      const n = execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').Name"`,
        { encoding: "utf8", timeout: 15000 }
      ).trim();
      return n || null;
    }
    return fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch { return null; }
}
function procParent(pid) {
  try {
    if (process.platform === "win32") {
      const n = execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId"`,
        { encoding: "utf8", timeout: 15000 }
      ).trim();
      return n ? Number(n) : null;
    }
    return null;
  } catch { return null; }
}

// Is something on this port already an opencode server we can reuse?
// (Warm restarts then skip the slow cold boot entirely.)
function probeOpencodeServer(hostname, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname, port, path: "/session", timeout: timeoutMs },
      (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => {
          try {
            const j = JSON.parse(body);
            resolve(res.statusCode === 200 && Array.isArray(j) ? true : false);
          } catch { resolve(false); }
        });
      }
    );
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

async function cmdStart() {
  if (!fs.existsSync(ENV_FILE)) {
    console.error(`No .env in ${DIR} — run \`opencode-gateway setup\` first.`);
    process.exit(1);
  }
  const old = readPid(DIR);
  if (old) { console.log(`Already running (pid ${old}). Use \`restart\` to bounce it.`); return; }
  const env = readEnv();
  const port = Number(env.OPENCODE_PORT || 4096);
  const hostname = env.OPENCODE_HOSTNAME || "127.0.0.1";
  const holder = portOwner(port);
  let attachUrl = env.OPENCODE_SERVER_URL || "";
  if (holder && !attachUrl) {
    const name = procName(holder) || "?";
    if (/opencode/i.test(name) && await probeOpencodeServer(hostname, port)) {
      // Warm server already here (e.g. left running) — attach instead of
      // cold-booting. Restarts become instant.
      attachUrl = `http://${hostname}:${port}`;
      ok(`Warm opencode server found (pid ${holder}) — attaching, no cold boot.`);
    } else {
      console.error(`Port ${port} is held by ${name} (pid ${holder}). Stop it or change OPENCODE_PORT, then retry.`);
      process.exit(1);
    }
  }
  const t0 = Date.now();
  const logFd = fs.openSync(path.join(DIR, LOG_FILE), "a");
  const errFd = fs.openSync(path.join(DIR, ERR_FILE), "a");
  const childEnv = { ...process.env };
  if (attachUrl && !childEnv.OPENCODE_SERVER_URL) childEnv.OPENCODE_SERVER_URL = attachUrl;
  const child = spawn(process.execPath, [GATEWAY_ENTRY], {
    cwd: DIR, detached: true, stdio: ["ignore", logFd, errFd], env: childEnv,
  });
  child.unref();
  fs.writeFileSync(path.join(DIR, PID_FILE), JSON.stringify({ pid: child.pid, startedAt: Date.now(), attached: !!attachUrl }));
  console.log(`Starting gateway (pid ${child.pid})${attachUrl ? " [attached mode]" : ""}… logs: ${path.join(DIR, LOG_FILE)}`);
  // wait for online marker, showing live progress from the log
  const logPath = path.join(DIR, LOG_FILE);
  let lastLine = "", warnedNet = false;
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    if (!pidAlive(child.pid)) {
      console.error("Process died during boot — tail of log:");
      tailLog(15);
      process.exit(1);
    }
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    if (log.includes("gateway online")) { ok(`Gateway online in ${Math.round((Date.now() - t0) / 1000)}s — send /start to your bot.`); return; }
    const lines = log.trim().split(/\r?\n/);
    const cur = lines[lines.length - 1] || "";
    if (!warnedNet && /launch failed|still unreachable/i.test(log)) {
      warnedNet = true;
      info("Telegram unreachable — gateway keeps retrying in background (VPN/proxy?). Server side is up.");
    }
    if (cur !== lastLine) {
      lastLine = cur;
      info(`[${Math.round((Date.now() - t0) / 1000)}s] ${cur.slice(0, 110)}`);
    }
  }
  warn("Still booting (first-ever opencode boot warms caches: models, LSP, plugins). Check `opencode-gateway status`.");
}

async function cmdStop({ keepServer = false } = {}) {
  const pid = readPid(DIR);
  if (!pid) { console.log("Not running (no live pidfile)."); }
  else {
    try { process.kill(pid); ok(`Stopped gateway (pid ${pid}).`); }
    catch (e) { warn(`Could not stop pid ${pid}: ${e.message}`); }
    fs.rmSync(path.join(DIR, PID_FILE), { force: true });
  }
  if (keepServer) return; // restart path: leave the warm server for attach mode
  // free the port only if the holder is OURS (child of the stopped gateway)
  // or an orphan — never touch a foreign `opencode serve` / TUI server.
  const env = readEnv();
  const port = Number(env.OPENCODE_PORT || 4096);
  await new Promise((r) => setTimeout(r, 2000));
  const holder = portOwner(port);
  if (holder && /opencode/i.test(procName(holder) || "")) {
    const parent = procParent(holder);
    const parentAlive = parent ? pidAlive(parent) : false;
    if (!parentAlive) {
      try { process.kill(holder); ok(`Freed port ${port} (orphaned opencode server).`); }
      catch {}
    } else {
      warn(`Port ${port} still held by pid ${holder} (belongs to live process ${parent}) — left alone.`);
    }
  }
}

function tailLog(n = 40) {
  const p = path.join(DIR, LOG_FILE);
  if (!fs.existsSync(p)) { console.log("(no log yet)"); return; }
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
  console.log(lines.slice(-n).join("\n"));
}

async function cmdStatus() {
  const pid = readPid(DIR);
  const env = readEnv();
  const port = Number(env.OPENCODE_PORT || 4096);
  console.log(`dir: ${DIR}`);
  console.log(`gateway: ${pid ? `running (pid ${pid})` : "stopped"}`);
  const holder = portOwner(port);
  console.log(`port ${port}: ${holder ? `held by pid ${holder} (${procName(holder) || "?"})` : "free"}`);
  console.log(`token: ${env.TELEGRAM_BOT_TOKEN ? "set" : "MISSING"} | allowed: ${env.ALLOWED_USER_IDS || "(open!)"} | work: ${env.WORK_DIR || "(unset)"}`);
}

// ---------- entry ----------
async function main() {
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(`opencode-gateway — Telegram remote for OpenCode

  setup [--token X --user-id Y --work-dir Z --model P/M --port N --yes --skip-checks --no-menu]
      Interactive wizard: validates bot, heals restricted networks, writes .env, publishes menu.
  start [--dir DIR]     Start the gateway in the background.
  stop [--dir DIR]      Stop it (also frees a stale opencode server port).
  restart [--dir DIR]   Fast restart (keeps the warm server, attaches instantly).
  status [--dir DIR]    pid, port, config sanity.
  logs [--dir DIR] [-n 60]   Tail the gateway log.`);
    return;
  }
  if (cmd === "setup") return setup().finally(() => rl?.close());
  if (cmd === "start") return cmdStart();
  if (cmd === "stop") return cmdStop();
  if (cmd === "restart") { await cmdStop({ keepServer: true }); return cmdStart(); }
  if (cmd === "status") return cmdStatus();
  if (cmd === "logs") return tailLog(Number(flags.n) || 40);
  console.error(`Unknown command: ${cmd}. See \`opencode-gateway help\`.`);
  process.exit(1);
}

main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
