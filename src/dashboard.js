// Post-start dashboard — the UI that opens after `opencode gateway start`.
//
// Live terminal view: gateway process, opencode server, sessions, Telegram
// route, config sanity + tail of the gateway log. Keys: q detach (leaves the
// gateway running), r restart, s stop, l more/fewer log lines.
// Zero dependencies. Skipped automatically when stdout isn't a TTY
// (use --no-ui on start to suppress, --once to print a single snapshot).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import {
  PID_FILE, LOG_FILE, ERR_FILE,
  readEnv, readPid, pidStartedAt, portOwner, procName,
  probeOpencodeServer, sessionCount, tailFile, fetchBotUsername,
} from "./daemon.js";

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
};
const green = (s) => `${C.green}${s}${C.reset}`;
const red = (s) => `${C.red}${s}${C.reset}`;
const yellow = (s) => `${C.yellow}${s}${C.reset}`;
const dim = (s) => `${C.dim}${s}${C.reset}`;
const bold = (s) => `${C.bold}${s}${C.reset}`;

function fmtUptime(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function line(width) {
  return dim("─".repeat(Math.max(10, width)));
}

// Gather everything the dashboard shows. Each probe is best-effort.
async function collect(dir, pkgRoot, botName) {
  const env = readEnv(dir);
  const pid = readPid(dir);
  const port = Number(env.OPENCODE_PORT || 4096);
  const hostname = env.OPENCODE_HOSTNAME || "127.0.0.1";
  const holder = portOwner(port);
  const serverUp = holder ? await probeOpencodeServer(hostname, port, 3000) : false;
  const sessions = serverUp ? await sessionCount(hostname, port, 3000) : -1;
  let attached = false;
  try {
    attached = !!JSON.parse(fs.readFileSync(path.join(dir, PID_FILE), "utf8")).attached;
  } catch {}
  const route = env.TELEGRAM_API_IP
    ? `pinned ${env.TELEGRAM_API_IP}`
    : env.HTTPS_PROXY ? "proxy" : env.TELEGRAM_API_ROOT ? "custom root" : "direct";
  return { env, pid, port, hostname, holder, serverUp, sessions, attached, route, botName, startedAt: pidStartedAt(dir) };
}

function render(s, { logLines, width }) {
  const W = Math.min(100, Math.max(60, width));
  const out = [];
  out.push(bold(`📱 opencode-gateway ${s.botName ? dim(`· ${s.botName} · https://t.me/${s.botName.slice(1)}`) : ""}`));
  out.push(line(W));
  const gw = s.pid
    ? `${green("● running")}  pid ${s.pid} · up ${fmtUptime(Date.now() - (s.startedAt ?? Date.now()))}`
    : red("○ stopped");
  out.push(`  gateway   ${gw}`);
  const srv = s.serverUp
    ? `${green("● opencode")} :${s.port} ${dim(s.attached ? "(attached to warm server)" : "(started by gateway)")}${s.sessions >= 0 ? ` · ${s.sessions} session${s.sessions === 1 ? "" : "s"}` : ""}`
    : s.holder
      ? `${yellow("● port " + s.port)} held by pid ${s.holder} (${procName(s.holder) || "?"}) — not opencode`
      : dim(`○ port ${s.port} free`);
  out.push(`  server    ${srv}`);
  out.push(`  telegram  ${s.route} ${dim("· notify → " + (s.env.TELEGRAM_NOTIFY_CHAT_IDS || "(unset)"))}`);
  const probs = [];
  if (!s.env.TELEGRAM_BOT_TOKEN) probs.push("token MISSING");
  if (!s.env.ALLOWED_USER_IDS) probs.push("ALLOWED_USER_IDS empty (open to all!)");
  if (!s.env.WORK_DIR) probs.push("WORK_DIR unset");
  out.push(`  config    ${probs.length ? yellow("! " + probs.join(" · ")) : green("token ✓ · allowed ✓ · work dir ✓")} ${dim(s.env.WORK_DIR || "")}`);
  out.push(line(W));
  out.push(bold(`  live log  ${dim(`(gateway.log, last ${logLines})`)}`));
  const log = tailFile(process.env.GW_DIR ? path.join(process.env.GW_DIR, LOG_FILE) : LOG_FILE, logLines);
  const body = (log || "(no log yet)").split("\n").slice(-logLines);
  for (const l of body) out.push(`  ${dim("│")} ${l.slice(0, W - 4)}`);
  if (!s.pid) {
    const errTail = tailFile(process.env.GW_DIR ? path.join(process.env.GW_DIR, ERR_FILE) : ERR_FILE, 5);
    if (errTail.trim()) {
      out.push(`  ${red("last errors:")}`);
      for (const l of errTail.split("\n").slice(-5)) out.push(`  ${dim("│")} ${red(l.slice(0, W - 4))}`);
    }
  }
  out.push(line(W));
  out.push(`  ${dim("[q] detach (keep running)   [r] restart   [s] stop gateway   [l] more log")}   ${dim("auto-refresh 2s")}`);
  return out.join("\n");
}

export async function runDashboard({ dir, pkgRoot, once = false }) {
  process.env.GW_DIR = dir; // render() helper reads log paths from here
  const width = process.stdout.columns || 90;

  // Bot name for the header — resolves in the background, dashboard doesn't wait.
  // Skipped for one-shot snapshots so they never hang on network.
  let botName = null;
  const interactive = process.stdout.isTTY && !once;
  const env0 = readEnv(dir);
  if (interactive && env0.TELEGRAM_BOT_TOKEN) {
    fetchBotUsername(pkgRoot, env0.TELEGRAM_BOT_TOKEN, env0).then((u) => {
      botName = u ? `@${u}` : null;
    });
  }

  const show = async (logLines) => {
    const s = await collect(dir, pkgRoot, botName);
    return render(s, { logLines, width: process.stdout.columns || width });
  };

  if (once || !process.stdout.isTTY) {
    console.log(await show(20));
    return;
  }

  let logLines = 12;
  let paused = false;
  let drawing = false;

  const draw = async () => {
    if (paused || drawing) return;
    drawing = true;
    try {
      process.stdout.write("\x1b[2J\x1b[H");
      process.stdout.write(await show(logLines));
      process.stdout.write("\n");
    } finally {
      drawing = false;
    }
  };

  readline.emitKeypressEvents(process.stdin);
  const canRaw = process.stdin.isTTY && typeof process.stdin.setRawMode === "function";
  if (canRaw) process.stdin.setRawMode(true);
  process.stdin.resume();

  let every = setInterval(draw, 2000);
  await draw();

  const cliEntry = path.join(pkgRoot, "src", "cli.js");
  const runCli = (args) => {
    paused = true;
    clearInterval(every);
    if (canRaw) process.stdin.setRawMode(false);
    process.stdout.write("\x1b[2J\x1b[H");
    spawnSync(process.execPath, [cliEntry, ...args, "--dir", dir, "--no-ui"], { stdio: "inherit" });
    paused = false;
    if (canRaw) process.stdin.setRawMode(true);
    every = setInterval(draw, 2000);
  };

  await new Promise((resolve) => {
    const done = (msg) => {
      clearInterval(every);
      try { if (canRaw) process.stdin.setRawMode(false); } catch {}
      process.stdin.removeListener("keypress", onKey);
      process.stdin.pause();
      if (msg) console.log(`\n${msg}`);
      resolve();
    };
    const onKey = (ch, key) => {
      const k = (key?.name || ch || "").toLowerCase();
      if (k === "q" || (key?.ctrl && key?.name === "c")) {
        done("Detached — gateway keeps running in the background. `opencode gateway status|logs|stop` anytime.");
      } else if (k === "l") {
        logLines = logLines >= 30 ? 12 : 30;
        draw();
      } else if (k === "r") {
        runCli(["restart"]);
        draw();
      } else if (k === "s") {
        runCli(["stop"]);
        const still = readPid(dir);
        done(still
          ? `Gateway is still running (pid ${still}) — check \`opencode gateway logs\`.`
          : "Gateway stopped. Start again with `opencode gateway start`.");
      }
    };
    process.stdin.on("keypress", onKey);
  });
  clearInterval(every);
}
