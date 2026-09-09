// OpenCode plugin: Telegram notifications + `telegram_send` tool.
// ZERO static imports on purpose — copy this single file to
// `.opencode/plugins/` or `~/.config/opencode/plugins/` and it works.
//
// npm install option (recommended):
//   opencode.json -> { "plugin": ["opencode-telegram-gateway"] }
//
// Env (read inside the opencode process):
//   TELEGRAM_BOT_TOKEN      — BotFather token (required for notifications)
//   TELEGRAM_NOTIFY_CHAT_IDS — comma-separated chat IDs to notify (required)
//   TELEGRAM_NOTIFY_ON      — comma list, default "session.idle,session.error,permission.asked"
//   TELEGRAM_NOTIFY_TOOLS   — "true" to also notify after each tool call (noisy)

const DEFAULT_EVENTS = ["session.idle", "session.error", "permission.asked"];

function apiTarget() {
  // Same TELEGRAM_API_ROOT convention as the gateway (generic reverse proxy
  // support, no vendor mandated). Falls back to direct api.telegram.org.
  try {
    const u = new URL((process.env.TELEGRAM_API_ROOT || "https://api.telegram.org").trim().replace(/\/$/, ""));
    return { protocol: u.protocol, hostname: u.hostname, port: u.port ? Number(u.port) : (u.protocol === "http:" ? 80 : 443), basePath: u.pathname.replace(/\/$/, "") };
  } catch {
    return { protocol: "https:", hostname: "api.telegram.org", port: 443, basePath: "" };
  }
}

function lookupOverride(hostname, opts, cb) {
  // TELEGRAM_API_IP pins api.telegram.org to a reachable DC (restricted networks)
  if (typeof opts === "function") { cb = opts; opts = {}; }
  if (hostname === "api.telegram.org" && process.env.TELEGRAM_API_IP?.trim()) {
    const pin = process.env.TELEGRAM_API_IP.trim();
    if (opts && opts.all) cb(null, [{ address: pin, family: 4 }]);
    else cb(null, pin, 4);
    return;
  }
  import("node:dns").then(({ lookup }) => lookup(hostname, opts, cb));
}

function postBotApi(token, method, payload) {
  // node:https/http with lookup override (works where fetch can't reach a blocked DC)
  return import("node:https").then(async ({ request: httpsRequest }) => {
    const t = apiTarget();
    const request = t.protocol === "http:"
      ? (await import("node:http")).request
      : httpsRequest;
    return new Promise((resolve) => {
      const data = JSON.stringify(payload);
      const req = request({
        hostname: t.hostname,
        port: t.port,
        path: `${t.basePath}/bot${token}/${method}`,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
        lookup: t.hostname === "api.telegram.org" ? lookupOverride : undefined,
        timeout: 15000,
      }, (res) => { res.resume(); res.on("end", resolve); });
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve());
      req.end(data);
    });
  });
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chats = (process.env.TELEGRAM_NOTIFY_CHAT_IDS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!token || chats.length === 0) return;
  const msg = String(text).slice(0, 4000);
  await Promise.all(chats.map((chat_id) =>
    postBotApi(token, "sendMessage", { chat_id, text: msg })
  ));
}

export const TelegramGatewayPlugin = async (ctx) => {
  const want = (process.env.TELEGRAM_NOTIFY_ON || DEFAULT_EVENTS.join(","))
    .split(",").map((s) => s.trim()).filter(Boolean);
  const notifyTools = (process.env.TELEGRAM_NOTIFY_TOOLS || "").toLowerCase() === "true";

  // Try to build a real `telegram_send` custom tool when the helper exists.
  let extraTools = {};
  try {
    const { tool } = await import("@opencode-ai/plugin");
    extraTools = {
      telegram_send: tool({
        description: "Send a message to the owner's Telegram chats (gateway notifications).",
        args: { text: tool.schema.string() },
        async execute(args) {
          await sendTelegram(args.text);
          return "sent";
        },
      }),
    };
  } catch {
    // helper not installed — notifications still work, tool is skipped
  }

  return {
    tool: extraTools,
    event: async ({ event }) => {
      const type = event?.type;
      if (!type) return;
      if (want.includes(type)) {
        const title = event.properties?.sessionID
          ? `${type} (${event.properties.sessionID.slice(0, 12)}…)`
          : type;
        await sendTelegram(`${title}\n${JSON.stringify(event.properties ?? {}, null, 2).slice(0, 2000)}`);
      } else if (notifyTools && type === "tool.execute.after") {
        await sendTelegram(`tool done: ${event.properties?.tool ?? "?"}`);
      }
    },
  };
};
