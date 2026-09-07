// Network helpers for reaching api.telegram.org from restricted networks.
// 1. TELEGRAM_API_IP — pin api.telegram.org to a reachable DC IP (no admin needed,
//    unlike editing the hosts file). TLS still verifies api.telegram.org via SNI.
// 2. HTTPS_PROXY / https_proxy — standard proxy support (e.g. VPN exit node).
// Both are optional; direct connection is tried when neither is set.

import https from "node:https";
import fs from "node:fs";

export function telegramLookup(hostname, opts, cb) {
  const pin = process.env.TELEGRAM_API_IP?.trim();
  if (typeof opts === "function") { cb = opts; opts = {}; }
  if (pin && hostname === "api.telegram.org") {
    // Node 20+ Happy Eyeballs resolves with { all: true } -> needs an array
    if (opts && opts.all) cb(null, [{ address: pin, family: 4 }]);
    else cb(null, pin, 4);
    return;
  }
  // default resolution
  import("node:dns").then(({ lookup }) => lookup(hostname, opts, cb));
}

export async function createTelegramAgent() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy) {
    const { HttpsProxyAgent } = await import("https-proxy-agent");
    console.log("[net] using proxy for Telegram");
    return new HttpsProxyAgent(proxy);
  }
  if (process.env.TELEGRAM_API_IP?.trim()) {
    console.log(`[net] pinning api.telegram.org -> ${process.env.TELEGRAM_API_IP.trim()}`);
    return new https.Agent({ lookup: telegramLookup, keepAlive: true });
  }
  return undefined; // direct
}

// Download a Telegram file (file_path from getFile) honoring the DC pin/proxy.
export function downloadTelegramFile(filePath, destAbs, timeoutMs = 120000) {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/file/bot${token}/${filePath}`,
      method: "GET",
      lookup: telegramLookup,
      timeout: timeoutMs,
    }, (res) => {
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
  });
}
export function telegramApi(method, payload, timeoutMs = 20000) {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const data = JSON.stringify(payload ?? {});
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${token}/${method}`,
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
      lookup: telegramLookup,
      timeout: timeoutMs,
    }, (res) => {
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
  });
}
