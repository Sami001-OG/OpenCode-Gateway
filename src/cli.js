#!/usr/bin/env node
// opencode-gateway — setup wizard + daemon control + live dashboard.
//
//   opencode gateway setup            interactive wizard (bot token, user id, ...)
//   opencode gateway setup --token X --user-id Y --work-dir Z --yes [--skip-checks]
//   opencode gateway start [--dir DIR] [--no-ui]
//   opencode gateway dashboard [--dir DIR]   reopen the live UI
//   opencode gateway stop|restart|status|logs [--dir DIR]
//
// (With the shell wrapper `opencode gateway …` forwards here; without it use
// `opencode-gateway …` or `node src/cli.js …`.)

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PID_FILE, LOG_FILE, ERR_FILE,
  readEnv, pidAlive, readPid, portOwner, procName, procParent, probeOpencodeServer,
} from "./daemon.js";

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GATEWAY_ENTRY = path.join(PKG_ROOT, "src", "index.js");

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

const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`\x1b[33m!\x1b[0m ${m}`);
const info = (m) => console.log(`  ${m}`);

// ---------- daemon control ----------
async function cmdStart() {
  if (!fs.existsSync(ENV_FILE)) {
    console.error(`No .env in ${DIR} — run \`opencode gateway setup\` first.`);
    process.exit(1);
  }
  const old = readPid(DIR);
  if (old) {
    console.log(`Already running (pid ${old}). Opening the dashboard…`);
    return cmdDashboard();
  }
  const env = readEnv(DIR);
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
    if (log.includes("gateway online")) {
      ok(`Gateway online in ${Math.round((Date.now() - t0) / 1000)}s — send /start to your bot.`);
      return cmdDashboard();
    }
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
  warn("Still booting (first-ever opencode boot warms caches: models, LSP, plugins). Check `opencode gateway status`.");
  return cmdDashboard();
}

// The live terminal UI — opens after a successful start, or on demand via
// `dashboard`. Never blocks scripts: skipped without a TTY or with --no-ui.
async function cmdDashboard() {
  if (flags["no-ui"]) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    info("Dashboard needs an interactive terminal — skipping (gateway keeps running).");
    info("Reopen it anytime with: opencode gateway dashboard");
    return;
  }
  const { runDashboard } = await import("./dashboard.js");
  await runDashboard({ dir: DIR, pkgRoot: PKG_ROOT, once: !!flags.once });
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
  const env = readEnv(DIR);
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
  const env = readEnv(DIR);
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
    console.log(`opencode gateway — Telegram remote for OpenCode

  setup [--token X --user-id Y --work-dir Z --model P/M --agent A --port N --yes --skip-checks --no-menu]
      Guided 7-step wizard: validates bot, heals restricted networks, writes .env, publishes menu.
  start [--dir DIR] [--no-ui]
      Start the gateway in the background, then open the live dashboard UI.
  dashboard [--dir DIR]
      Reopen the live dashboard UI (status, sessions, log tail, restart/stop keys).
  stop [--dir DIR]      Stop it (also frees a stale opencode server port).
  restart [--dir DIR]   Fast restart (keeps the warm server, attaches instantly).
  status [--dir DIR]    pid, port, config sanity.
  logs [--dir DIR] [-n 60]   Tail the gateway log.`);
    return;
  }
  if (cmd === "setup") {
    const { runSetup, closeRl } = await import("./setup.js");
    try {
      const startNow = await runSetup({ flags, dir: DIR, pkgRoot: PKG_ROOT });
      if (startNow) return cmdStart();
    } finally {
      closeRl();
    }
    return;
  }
  if (cmd === "start") return cmdStart();
  if (cmd === "dashboard") {
    const { runDashboard } = await import("./dashboard.js");
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      if (flags.once) return runDashboard({ dir: DIR, pkgRoot: PKG_ROOT, once: true });
      console.error("Dashboard needs an interactive terminal.");
      process.exit(1);
    }
    return runDashboard({ dir: DIR, pkgRoot: PKG_ROOT, once: !!flags.once });
  }
  if (cmd === "stop") return cmdStop();
  if (cmd === "restart") { await cmdStop({ keepServer: true }); return cmdStart(); }
  if (cmd === "status") return cmdStatus();
  if (cmd === "logs") return tailLog(Number(flags.n) || 40);
  console.error(`Unknown command: ${cmd}. See \`opencode gateway help\`.`);
  process.exit(1);
}

main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
