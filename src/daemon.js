// Shared daemon helpers — pidfile, ports, .env, server probing.
// Used by cli.js (start/stop/status), setup.js (wizard) and dashboard.js (UI).
// Zero dependencies.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execSync } from "node:child_process";

export const PID_FILE = ".gateway.pid";
export const LOG_FILE = "gateway.log";
export const ERR_FILE = "gateway.err.log";

export const ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN", "ALLOWED_USER_IDS", "TELEGRAM_NOTIFY_CHAT_IDS",
  "WORK_DIR", "OPENCODE_SERVER_URL", "OPENCODE_HOSTNAME", "OPENCODE_PORT",
  "OPENCODE_MODEL", "OPENCODE_AGENT", "CLI_ENABLED", "TELEGRAM_API_IP", "HTTPS_PROXY",
  "TELEGRAM_API_ROOT",
];

export function envFile(dir) {
  return path.join(dir, ".env");
}

// Read .env into an object (never prints values — callers must mask secrets).
export function readEnv(dir) {
  const out = {};
  const file = envFile(dir);
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// Write .env with known keys first (stable order), then any extras.
export function writeEnv(dir, obj) {
  const lines = ["# Managed by `opencode-gateway setup` - secrets stay here, never commit."];
  for (const k of ENV_KEYS) if (obj[k] !== undefined && obj[k] !== "") lines.push(`${k}=${obj[k]}`);
  for (const k of Object.keys(obj)) if (!ENV_KEYS.includes(k) && obj[k] !== "") lines.push(`${k}=${obj[k]}`);
  fs.writeFileSync(envFile(dir), lines.join("\n") + "\n");
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Live gateway pid, or null. Guards against PID reuse by checking the command line.
export function readPid(dir) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, PID_FILE), "utf8"));
    if (!pidAlive(p.pid)) return null;
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

export function pidStartedAt(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, PID_FILE), "utf8")).startedAt ?? null;
  } catch { return null; }
}

// Windows + unix best-effort listener lookup: pid holding this TCP port, or null.
export function portOwner(port) {
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

export function procName(pid) {
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

export function procParent(pid) {
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
export function probeOpencodeServer(hostname, port, timeoutMs = 5000) {
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

// How many sessions does the opencode server currently hold? Best-effort (-1 = unknown).
export function sessionCount(hostname, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname, port, path: "/session", timeout: timeoutMs },
      (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => {
          try {
            const j = JSON.parse(body);
            resolve(res.statusCode === 200 && Array.isArray(j) ? j.length : -1);
          } catch { resolve(-1); }
        });
      }
    );
    req.on("timeout", () => { req.destroy(); resolve(-1); });
    req.on("error", () => resolve(-1));
  });
}

// Last n lines of a file ("" when missing).
export function tailFile(filePath, n = 40) {
  try {
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/).slice(-n).join("\n");
  } catch { return ""; }
}

// Bot username for t.me links / menu publishing. Best-effort, never throws.
export async function fetchBotUsername(pkgRoot, token, env) {
  try {
    const { telegramApi } = await import(path.join(pkgRoot, "src", "net.js"));
    const prevToken = process.env.TELEGRAM_BOT_TOKEN;
    const prevPin = process.env.TELEGRAM_API_IP;
    const prevRoot = process.env.TELEGRAM_API_ROOT;
    const prevProxy = process.env.HTTPS_PROXY;
    process.env.TELEGRAM_BOT_TOKEN = token;
    if (env.TELEGRAM_API_IP) process.env.TELEGRAM_API_IP = env.TELEGRAM_API_IP;
    if (env.TELEGRAM_API_ROOT) process.env.TELEGRAM_API_ROOT = env.TELEGRAM_API_ROOT;
    if (env.HTTPS_PROXY) process.env.HTTPS_PROXY = env.HTTPS_PROXY;
    try {
      const r = await telegramApi("getMe", {}, 12000);
      return r?.ok ? r.result.username : null;
    } finally {
      if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = prevToken;
      if (prevPin === undefined) delete process.env.TELEGRAM_API_IP;
      else process.env.TELEGRAM_API_IP = prevPin;
      if (prevRoot === undefined) delete process.env.TELEGRAM_API_ROOT;
      else process.env.TELEGRAM_API_ROOT = prevRoot;
      if (prevProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = prevProxy;
    }
  } catch { return null; }
}

export function gatewayVersion(pkgRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version ?? "?";
  } catch { return "?"; }
}
