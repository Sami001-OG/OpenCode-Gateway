// OpenCode server transport: supports BOTH API generations.
//   v1  — opencode <= 1.19.x, plain http://host:port, no auth
//   v2  — opencode >= 2.x, http://host:port/api + HTTP Basic password printed
//         by `opencode serve` (or OPENCODE_SERVER_PASSWORD for attached servers)
//
// v2 keeps most of the v1 route names under /api, so we reuse the v1 SDK client
// with a different baseUrl and patch only the endpoints whose path or payload
// actually changed. This avoids maintaining two full client implementations.

import { spawn } from "node:child_process";

export function isTermux() {
  return !!process.env.TERMUX_VERSION ||
    String(process.env.PREFIX ?? "").includes("com.termux");
}

export function authHeaders(password) {
  const headers = {};
  if (password) {
    headers.Authorization = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  }
  // v2 scopes sessions/projects by directory.
  headers["x-opencode-directory"] = encodeURIComponent(process.cwd());
  return headers;
}

// Spawn `opencode serve` and read BOTH the URL and (for v2) the password from
// stdout. Older servers print "opencode server listening on ...", newer ones
// print "server listening on ..." followed by "server password ...".
const redactServeOutput = (s) => String(s ?? "").replace(/server password\s+\S+/gi, "server password <redacted>");

export function startServer({ hostname = "127.0.0.1", port = 4096, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn("opencode", ["serve", `--hostname=${hostname}`, `--port=${port}`], {
      env: { ...process.env, OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT ?? "{}" },
    });
    let output = "", url = "", password = "", settled = false;
    let graceTimer = null;

    const finish = () => {
      if (settled || !url) return;
      settled = true;
      clearTimeout(timer);
      resolve({ url, password, proc, close: () => { try { proc.kill(); } catch {} } });
    };
    const scan = () => {
      for (const line of output.split(/\r?\n/)) {
        const u = line.match(/opencode server listening on\s+(https?:\/\/\S+)/i) ||
                  line.match(/server listening on\s+(https?:\/\/\S+)/i);
        if (u && !url) {
          url = u[1].replace(/\/$/, "");
          // v2 prints the password on the following line — give it a moment.
          graceTimer = setTimeout(finish, 500);
        }
        const p = line.match(/server password\s+(\S+)/i);
        if (p) password = p[1];
      }
    };
    proc.stdout?.on("data", (d) => { output += d.toString(); scan(); if (password && url) finish(); });
    proc.stderr?.on("data", (d) => { output += d.toString(); });
    proc.on("error", (e) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(e); }
    });
    proc.on("exit", (code) => {
      if (!settled) {
        settled = true; clearTimeout(timer);
        reject(new Error(`opencode serve exited ${code}: ${redactServeOutput(output.slice(-600))}`));
      }
    });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`Timed out waiting for opencode server (${timeout}ms). ${redactServeOutput(output.slice(-400))}`));
      }
    }, timeout);
  });
}

// Raw JSON helper for v2-only routes. Returns { data } so the caller's existing
// unwrap() logic keeps working unchanged.
export async function rawFetch(baseUrl, headers, path, { method = "GET", body } = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = text; }
  if (!res.ok) throw new Error(`v2 API ${method} ${path} -> ${res.status}: ${String(text).slice(0, 180)}`);
  if (json && typeof json === "object" && "data" in json) return json; // already enveloped by v2
  return { data: json };
}

// Map a v2 message (id/type/content) to the v1 {info, parts} shape the gateway
// already knows how to render.
export function normalizeMessage(m) {
  const parts = [];
  for (const c of m?.content ?? []) {
    // Only genuine text is user-facing. v2 also carries a `reasoning` block —
    // exposing it would leak the model's private chain-of-thought to chat.
    if (c?.type === "text" && typeof c.text === "string") parts.push({ type: "text", text: c.text });
  }
  return {
    info: { id: m?.id, role: m?.type, sessionID: m?.sessionID, error: m?.error, time: m?.time },
    parts: parts.length ? parts : [{ type: "text", text: "" }],
  };
}

// Proxy that lets us override only the methods that changed in v2.
function wrap(real, overrides) {
  return new Proxy(real, {
    get(target, prop) {
      const override = overrides[prop];
      const value = target[prop];
      // Merge at every level: an override group must NOT hide the unpatched
      // methods of the real client (e.g. session.list / session.create).
      if (override && typeof override === "object" && value && typeof value === "object") {
        return wrap(value, override);
      }
      if (typeof override === "function") return override;
      if (value && typeof value === "object") return wrap(value, {});
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function v2Overrides(baseUrl, headers) {
  const raw = (p, o) => rawFetch(baseUrl, headers, p, o);
  return {
    path: {
      get: async () => ({ data: { cwd: process.cwd() } }),
    },
    session: {
      status: async () => {
        const r = await raw("/session/active");
        const d = r?.data ?? {};
        const out = {};
        for (const [id, v] of Object.entries(d)) out[id] = { type: v?.status && v.status !== "idle" ? v.status : "idle" };
        return out;
      },
      promptAsync: async ({ path, body }) => {
        const sid = encodeURIComponent(path.id);
        // v2 ignores per-prompt model/agent — apply them to the session first.
        if (body?.model) {
          const m = body.model;
          await raw(`/session/${sid}/model`, {
            method: "POST",
            body: { model: { id: m.modelID, providerID: m.providerID, ...(m.variant ? { variant: m.variant } : {}) } },
          });
        }
        if (body?.agent) {
          await raw(`/session/${sid}/agent`, { method: "POST", body: { agent: body.agent } });
        }
        const text = (body?.parts ?? []).filter((p) => p?.type === "text").map((p) => p.text).join("\n");
        const files = (body?.parts ?? []).filter((p) => p?.type === "file")
          .map((f) => ({ uri: f.url, name: f.filename }));
        // Installed v2 servers take the prompt fields at the top level:
        // { text, files? } (the SDK type is stale).
        return raw(`/session/${encodeURIComponent(path.id)}/prompt`, {
          method: "POST",
          body: { text, ...(files.length ? { files } : {}), ...(body?.variant ? { variant: body.variant } : {}) },
        });
      },
      messages: async ({ path, query }) => {
        const limit = query?.limit ?? 8;
        try {
          const r = await raw(`/session/${encodeURIComponent(path.id)}/message?limit=${limit}`);
          const arr = Array.isArray(r?.data) ? r.data : [];
          return arr.map(normalizeMessage);
        } catch (e) {
          // A brand-new session has no message resource yet.
          if (/404/.test(e.message)) return [];
          throw e;
        }
      },
      abort: async ({ path }) => raw(`/session/${encodeURIComponent(path.id)}/interrupt`, { method: "POST" }),
      // v2 exposes the same session operations under /api — wire them up
      // instead of returning "not supported" (verified against v2.2.7).
      // v2.2.7's real routes (confirmed from its openapi.json) differ from the
      // bundled SDK's generated routes: summarize is /compact; share/unshare,
      // unrevert and todo do not exist. Fail clearly instead of issuing a 404.
      share: async () => { throw new Error("/share is not exposed by this OpenCode v2 server"); },
      unshare: async () => { throw new Error("/unshare is not exposed by this OpenCode v2 server"); },
      fork: async ({ path, body }) => raw(`/session/${encodeURIComponent(path.id)}/fork`, { method: "POST", body }),
      summarize: async ({ path }) => raw(`/session/${encodeURIComponent(path.id)}/compact`, { method: "POST" }),
      revert: async ({ path, body }) => raw(`/session/${encodeURIComponent(path.id)}/revert`, { method: "POST", body }),
      unrevert: async () => { throw new Error("/unrevert is not exposed by this OpenCode v2 server"); },
      diff: async ({ path }) => raw(`/session/${encodeURIComponent(path.id)}/diff`),
      todo: async () => ({ data: [] }),
      shell: async ({ path, body }) => {
        const d = (await raw(`/session/${encodeURIComponent(path.id)}/shell`, { method: "POST", body }))?.data ?? {};
        return { data: d.info ?? d };
      },
      command: async ({ path, body }) => raw(`/session/${encodeURIComponent(path.id)}/command`, {
        method: "POST",
        body: { command: body?.command, arguments: body?.arguments ?? "" },
      }),
      // v2 permission replies live on the session, not the old top-level route.
      postSessionIdPermissionsPermissionId: async ({ path, body }) => {
        const map = { allow: "once", once: "once", always: "always", deny: "reject", reject: "reject" };
        return raw(`/session/${encodeURIComponent(path.id)}/permission/${encodeURIComponent(path.permissionID)}/reply`, {
          method: "POST",
          body: { reply: map[String(body?.response).toLowerCase()] ?? "once" },
        });
      },
    },
    file: {
      read: async ({ query }) => raw(`/fs/read?path=${encodeURIComponent(query?.path ?? "")}`),
      list: async ({ query }) => raw(`/fs/list?path=${encodeURIComponent(query?.path ?? ".")}`),
      status: async () => ({ data: {} }),
    },
    find: {
      text: async ({ query }) => raw(`/fs/find?query=${encodeURIComponent(query?.pattern ?? "")}`),
      files: async ({ query }) => raw(`/fs/find?query=${encodeURIComponent(query?.query ?? "")}`),
      symbols: async ({ query }) => raw(`/fs/find?query=${encodeURIComponent(query?.query ?? "")}`),
    },
    config: {
      // v2 splits providers and models into two endpoints — combine them into
      // the v1 { providers: [{ id, name, models }] } shape.
      providers: async () => {
        const [p, m] = await Promise.all([raw("/provider"), raw("/model")]);
        const providers = (p?.data ?? []).map((x) => ({ ...x, models: [] }));
        const byId = new Map(providers.map((x) => [x.id, x]));
        for (const mo of (m?.data ?? [])) {
          let pr = byId.get(mo.providerID);
          if (!pr) {
            pr = { id: mo.providerID, name: mo.providerID, models: [] };
            providers.push(pr); byId.set(pr.id, pr);
          }
          pr.models.push({
            id: mo.id ?? mo.modelID,
            modelID: mo.modelID ?? mo.id,
            name: mo.name ?? mo.id,
            variants: (mo.variants ?? []).map((v) => (typeof v === "string" ? v : v.id)).filter(Boolean),
          });
        }
        return { data: { providers } };
      },
      get: async () => raw("/config"),
    },
    app: { agents: async () => raw("/agent") },
    command: { list: async () => raw("/command") },
    mcp: { status: async () => raw("/mcp") },
    lsp: { status: async () => raw("/lsp") },
    formatter: { status: async () => raw("/formatter") },
    event: {
      subscribe: async (options = {}) => {
        // Best-effort SSE bridge; v2 event payloads differ from v1, but the
        // activity feed only looks at event.type / properties. Use the caller's
        // signal — a hard 30s timeout used to kill a healthy long-lived stream.
        const res = await fetch(`${baseUrl}/event`, { headers, signal: options.signal });
        const reader = res.body?.getReader?.();
        if (!reader) return { stream: (async function* () {})() };
        const decoder = new TextDecoder();
        return {
          stream: (async function* () {
            let buf = "";
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              let i;
              while ((i = buf.indexOf("\n\n")) >= 0) {
                const block = buf.slice(0, i); buf = buf.slice(i + 2);
                const line = block.split("\n").find((l) => l.startsWith("data:"));
                if (!line) continue;
                try { yield JSON.parse(line.slice(5).trim()); } catch {}
              }
            }
          })(),
        };
      },
    },
  };
}

export async function createTransport({ serverUrl = "", hostname = "127.0.0.1", port = 4096, timeout = 60000 } = {}) {
  let url = serverUrl.replace(/\/$/, ""), password = process.env.OPENCODE_SERVER_PASSWORD ?? "", close = () => {};
  if (!url) {
    const started = await startServer({ hostname, port, timeout });
    url = started.url;
    password = started.password || password;
    close = started.close;
  }

  let mode = password ? "v2" : "v1";
  if (!password) {
    // A user-supplied v2 URL may be unauthenticated — probe before choosing.
    try {
      const r = await fetch(`${url}/api/session`, {
        headers: authHeaders(""), signal: AbortSignal.timeout(4000),
      });
      if (r.ok) mode = "v2";
    } catch {}
  }

  const headers = mode === "v2" ? authHeaders(password) : undefined;
  const baseUrl = mode === "v2" ? `${url}/api` : url;
  const { createOpencodeClient } = await import("@opencode-ai/sdk");
  const real = createOpencodeClient({ baseUrl, ...(headers ? { headers } : {}) });
  const client = mode === "v2" ? wrap(real, v2Overrides(baseUrl, headers)) : real;
  const raw = (p, opts) => rawFetch(baseUrl, headers, p, opts);
  return { mode, client, close, url, password, raw };
}
