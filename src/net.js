// Network layer for reaching the Telegram Bot API from anywhere —
// including restricted networks. Resolution order (automatic, no accounts):
//   1. direct -> 2. pinned DC IP (TLS-verified) -> 3. HTTPS_PROXY ->
//   4. clear diagnosis (never a bare stack trace).
//
// Env:
//   TELEGRAM_BOT_TOKEN   BotFather token (all calls)
//   TELEGRAM_API_ROOT    Custom Bot API root, e.g. your own reverse proxy.
//                        Default: https://api.telegram.org (direct).
//   TELEGRAM_API_IP      Pin api.telegram.org to one DC IP (restricted nets).
//   HTTPS_PROXY          Proxy for Telegram traffic.

import https from "node:https";
import http from "node:http";
import fs from "node:fs";

const DEFAULT_ROOT = "https://api.telegram.org";

export function apiTarget() {
  const root = (process.env.TELEGRAM_API_ROOT || DEFAULT_ROOT).trim().replace(/\/$/, "") || DEFAULT_ROOT;
  const u = new URL(root);
  return {
    root,
    protocol: u.protocol, // "https:" | "http:"
    hostname: u.hostname,
    port: u.port ? Number(u.port) : (u.protocol === "http:" ? 80 : 443),
    basePath: u.pathname.replace(/\/$/, ""),
    isDefaultHost: u.hostname === "api.telegram.org",
  };
}

export function telegramLookup(hostname, opts, cb) {
  const pin = process.env.TELEGRAM_API_IP?.trim();
  if (typeof opts === "function") { cb = opts; opts = {}; }
  // Pin only applies to the default host (a custom root resolves normally).
  if (pin && hostname === "api.telegram.org") {
    // Node 20+ Happy Eyeballs resolves with { all: true } -> needs an array
    if (opts && opts.all) cb(null, [{ address: pin, family: 4 }]);
    else cb(null, pin, 4);
    return;
  }
  import("node:dns").then(({ lookup }) => lookup(hostname, opts, cb));
}

async function buildAgent(target) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy) {
    const { HttpsProxyAgent } = await import("https-proxy-agent");
    return new HttpsProxyAgent(proxy);
  }
  if (target.isDefaultHost && process.env.TELEGRAM_API_IP?.trim()) {
    return new https.Agent({ lookup: telegramLookup, keepAlive: true });
  }
  return undefined; // direct
}

export async function createTelegramAgent() {
  const t = apiTarget();
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy) console.log("[net] using proxy for Telegram");
  else if (t.isDefaultHost && process.env.TELEGRAM_API_IP?.trim()) {
    console.log(`[net] pinning api.telegram.org -> ${process.env.TELEGRAM_API_IP.trim()}`);
  } else if (!t.isDefaultHost) {
    console.log(`[net] custom Bot API root: ${t.root}`);
  }
  return buildAgent(t);
}

// POST https://<root>/bot<token>/<method> — returns parsed JSON.
export function telegramApi(method, payload, timeoutMs = 20000) {
  const t = apiTarget();
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const data = JSON.stringify(payload ?? {});
  const lib = t.protocol === "http:" ? http : https;
  return buildAgent(t).then((agent) => new Promise((resolve, reject) => {
    const opts = {
      hostname: t.hostname,
      port: t.port,
      path: `${t.basePath}/bot${token}/${method}`,
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
      timeout: timeoutMs,
    };
    if (agent) opts.agent = agent;
    else opts.lookup = telegramLookup;
    const req = lib.request(opts, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`bad response: ${body.slice(0, 200)}`)); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(data);
  }));
}

// Download a Telegram file (file_path from getFile) honoring root/pin/proxy.
export function downloadTelegramFile(filePath, destAbs, timeoutMs = 120000) {
  const t = apiTarget();
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const lib = t.protocol === "http:" ? http : https;
  return buildAgent(t).then((agent) => new Promise((resolve, reject) => {
    const opts = {
      hostname: t.hostname,
      port: t.port,
      path: `${t.basePath}/file/bot${token}/${filePath}`,
      method: "GET",
      timeout: timeoutMs,
    };
    if (agent) opts.agent = agent;
    else opts.lookup = telegramLookup;
    const req = lib.request(opts, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`file download http ${res.statusCode}`));
        return;
      }
      const out = fs.createWriteStream(destAbs);
      res.pipe(out);
      out.on("finish", () => resolve(destAbs));
      out.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("file download timeout")));
    req.on("error", reject);
    req.end();
  }));
}

// ---------- automatic route resolution ----------

// getMe with an explicit token (does not depend on ambient env).
export async function checkBot(token, { timeoutMs = 12000 } = {}) {
  const prev = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = token;
  try {
    return await telegramApi("getMe", {}, timeoutMs);
  } finally {
    if (prev === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = prev;
  }
}

// TLS-scan candidate DC IPs; keep only genuine api.telegram.org frontends.
// Never sends the token — aborts right after cert verification.
export async function scanDcPins(
  candidates = ["149.154.167.220", "149.154.167.51", "149.154.166.120", "91.108.56.100", "149.154.175.100"],
  timeoutMs = 6000
) {
  const tls = await import("node:tls");
  const tryIp = (ip) => new Promise((res) => {
    const s = tls.connect({ host: ip, port: 443, servername: "api.telegram.org", timeout: timeoutMs }, () => {
      const good = s.authorized && /telegram\.org/i.test(String(s.getPeerCertificate()?.subjectaltname || ""));
      s.destroy();
      res(good ? ip : null);
    });
    s.on("timeout", () => { s.destroy(); res(null); });
    s.on("error", () => res(null));
  });
  return (await Promise.all(candidates.map(tryIp))).filter(Boolean);
}

function hintFor(err) {
  const m = String(err?.message ?? err);
  if (/timeout|timed out|etimedout/i.test(m)) return "TCP blocked/throttled (packets die on the way)";
  if (/eproto|packet length|ssl/i.test(m)) return "TLS interfered with (middlebox answering instead of Telegram)";
  if (/econnreset|econnrefused|enotfound|eai_again/i.test(m)) return "connection reset/refused (filter or dead route)";
  if (/414/.test(m)) return "HTTP proxy mangling long Bot API URLs";
  return m.slice(0, 120);
}

// Full chain: direct -> pinned DC -> proxy env -> diagnosis.
// Returns { mode, pin, bot, diagnosis } — never throws.
export async function resolveTelegramRoute(token, { timeoutMs = 12000 } = {}) {
  const diagnosis = [];
  // Custom root: trust it, just verify.
  const t = apiTarget();
  if (!t.isDefaultHost) {
    try {
      const r = await checkBot(token, { timeoutMs });
      if (r?.ok) return { mode: "custom-root", pin: "", bot: r.result, diagnosis };
      return { mode: "failed", pin: "", bot: null, diagnosis: [...diagnosis, `custom root answered but rejected token: ${JSON.stringify(r).slice(0, 150)}`] };
    } catch (e) {
      return { mode: "failed", pin: "", bot: null, diagnosis: [...diagnosis, `custom root unreachable: ${hintFor(e)}`] };
    }
  }
  // 1. direct. Temporarily ignore a configured proxy so the diagnosis really
  // distinguishes a blocked direct route from a working proxy route.
  const prevPin = process.env.TELEGRAM_API_IP;
  const prevProxy = process.env.HTTPS_PROXY;
  const prevLowerProxy = process.env.https_proxy;
  delete process.env.TELEGRAM_API_IP;
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  try {
    const r = await checkBot(token, { timeoutMs });
    if (r?.ok) return { mode: "direct", pin: "", bot: r.result, diagnosis };
    diagnosis.push(`direct: token rejected (${JSON.stringify(r).slice(0, 120)})`);
    return { mode: "failed", pin: "", bot: null, diagnosis };
  } catch (e) {
    diagnosis.push(`direct: ${hintFor(e)}`);
  } finally {
    if (prevPin === undefined) delete process.env.TELEGRAM_API_IP;
    else process.env.TELEGRAM_API_IP = prevPin;
    if (prevProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = prevProxy;
    if (prevLowerProxy === undefined) delete process.env.https_proxy;
    else process.env.https_proxy = prevLowerProxy;
  }
  // 2. pinned DC (also without the proxy; the proxy is tested separately).
  const pins = await scanDcPins();
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  for (const pin of pins) {
    process.env.TELEGRAM_API_IP = pin;
    try {
      const r = await checkBot(token, { timeoutMs });
      if (r?.ok) return { mode: "pinned", pin, bot: r.result, diagnosis };
      diagnosis.push(`pin ${pin}: token rejected`);
      break;
    } catch (e) {
      diagnosis.push(`pin ${pin}: ${hintFor(e)}`);
    } finally {
      if (prevPin === undefined) delete process.env.TELEGRAM_API_IP;
      else process.env.TELEGRAM_API_IP = prevPin;
    }
  }
  if (pins.length === 0) diagnosis.push("pin scan: no genuine Telegram frontend reachable");

  // 3. proxy env present — verify through it.
  if (prevProxy || prevLowerProxy) {
    try {
      const r = await checkBot(token, { timeoutMs });
      if (r?.ok) return { mode: "proxy", pin: "", bot: r.result, diagnosis };
      diagnosis.push("proxy: token rejected");
      return { mode: "failed", pin: "", bot: null, diagnosis };
    } catch (e) {
      diagnosis.push(`proxy: ${hintFor(e)}`);
    }
  }
  return { mode: "failed", pin: "", bot: null, diagnosis };
}
