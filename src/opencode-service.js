// Core OpenCode gateway for the Telegram bot (future transports plug in here).
// Talks to `opencode serve` via @opencode-ai/sdk + `opencode` CLI passthrough
// for full parity (every CLI command reachable from chat).
//
// Design note on "every tool": the 13 built-in tools
// (bash, edit, write, read, grep, glob, lsp, apply_patch, skill,
//  todowrite, webfetch, websearch, question) + custom tools + MCP tools
// all live INSIDE the agent session. Plain messages use them automatically.
// The /bash, /read, ... commands below are explicit shortcuts: read-only
// ones hit the server API directly (fast, no LLM cost), mutating ones ask
// the agent to use exactly that tool (so permissions, hooks and logging
// behave identically to the CLI).

import { spawn } from "node:child_process";
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";

export const BUILTIN_TOOLS = [
  "bash", "edit", "write", "read", "grep", "glob", "lsp",
  "apply_patch", "skill", "todowrite", "webfetch", "websearch", "question",
];

function unwrap(res) {
  // SDK responseStyle="fields" envelopes: { data, error } or { data, request, response }.
  if (!res || typeof res !== "object") return res;
  if ("data" in res) {
    if ("error" in res && res.error) {
      throw new Error(typeof res.error === "string" ? res.error : JSON.stringify(res.error));
    }
    return res.data;
  }
  return res;
}

function parseModel(modelStr) {
  if (!modelStr) return undefined;
  const slash = modelStr.indexOf("/");
  if (slash <= 0) return undefined;
  return {
    providerID: modelStr.slice(0, slash).trim(),
    modelID: modelStr.slice(slash + 1).trim(),
  };
}

// Unwrap opencode's sometimes double-encoded error strings:
// { message: "\"Model not found: ...\"" } -> Model not found: ...
export function cleanErrorText(v) {
  let s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  for (let i = 0; i < 3; i++) {
    const t = s.trim();
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
      try { s = JSON.parse(t); continue; } catch { s = t.slice(1, -1); }
    }
    break;
  }
  return String(s).slice(0, 800);
}

export function errorMessage(err) {
  return cleanErrorText(err?.data?.message ?? err?.message ?? err);
}

function extractText(promptResult) {
  const data = unwrap(promptResult);
  if (!data || typeof data !== "object") return String(data ?? "(empty response from OpenCode)");
  // prompt/command return { info, parts }
  const parts = data?.parts ?? [];
  const texts = [];
  for (const p of parts) {
    if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) texts.push(p.text);
  }
  if (texts.length > 0) return texts.join("\n\n");
  if (typeof data?.info?.structured_output !== "undefined") {
    return "```json\n" + JSON.stringify(data.info.structured_output, null, 2) + "\n```";
  }
  if (data?.info?.error) {
    return `OpenCode error: ${data.info.error?.message ?? JSON.stringify(data.info.error)}`;
  }
  return "(empty response from OpenCode)";
}

export const TOOL_LABELS = {
  bash: "⚙️ running shell command…",
  read: "📖 reading files…",
  edit: "✏️ editing files…",
  write: "📝 writing files…",
  grep: "🔍 searching code…",
  glob: "📁 finding files…",
  lsp: "🔬 analyzing code…",
  apply_patch: "🩹 applying patch…",
  skill: "🧠 loading skill…",
  todowrite: "📋 updating tasks…",
  webfetch: "🌐 fetching page…",
  websearch: "🌐 searching the web…",
  question: "❓ has a question for you…",
};
const THINKING = "💭 thinking…";

export class OpencodeService {
  constructor({ defaultModel = "", cliEnabled = true, cliTimeoutMs = 120000 } = {}) {
    this.defaultModel = defaultModel;
    this.cliEnabled = cliEnabled;
    this.cliTimeoutMs = cliTimeoutMs;
    this.client = null;
    this.server = null;
    this.sessions = new Map(); // userKey -> { sessionID, title, model, agent }
    this.busy = new Set();
    this.eventHandlers = new Set();
    this.sessionUser = new Map(); // sessionID -> userKey (for live activity)
    this.activity = new Map(); // userKey -> { text, at }
  }

  async init({ serverUrl = "", hostname = "127.0.0.1", port = 4096, timeout = 60000 } = {}) {
    if (serverUrl) {
      this.client = createOpencodeClient({ baseUrl: serverUrl.replace(/\/$/, "") });
      // ping (installed server v1.18.x has no /global/health — path.get proves we're live)
      const pong = unwrap(await this.client.path.get());
      console.log(`[opencode] attached to ${serverUrl} (cwd=${pong?.cwd ?? "?"})`);
    } else {
      const instance = await createOpencode({ hostname, port: Number(port), timeout });
      this.server = instance;
      this.client = instance.client;
      console.log(`[opencode] server started at ${instance.server?.url ?? `http://${hostname}:${port}`}`);
    }
  }

  // ---------- session bookkeeping ----------
  getState(userKey) {
    if (!this.sessions.has(userKey)) {
      this.sessions.set(userKey, { sessionID: null, title: "telegram", model: this.defaultModel, agent: "" });
    }
    return this.sessions.get(userKey);
  }

  async newSession(userKey, title = "telegram") {
    const session = unwrap(await this.client.session.create({ body: { title: title.slice(0, 60) || "telegram" } })) ?? {};
    const state = this.getState(userKey);
    state.sessionID = session.id ?? null;
    state.title = title;
    this.trackSession(userKey, state.sessionID);
    if (!state.sessionID) throw new Error("OpenCode did not return a session id");
    return state.sessionID;
  }

  async ensureSession(userKey) {
    const state = this.getState(userKey);
    if (state.sessionID) {
      this.trackSession(userKey, state.sessionID);
      return state.sessionID;
    }
    return this.newSession(userKey, state.title || "telegram");
  }

  // ---------- live activity (what is the harness doing right now?) ----------
  trackSession(userKey, sessionID) {
    if (sessionID) this.sessionUser.set(sessionID, userKey);
  }
  setActivity(userKey, text) {
    this.activity.set(userKey, { text, at: Date.now() });
  }
  getActivity(userKey) {
    return this.activity.get(userKey)?.text ?? null;
  }
  clearActivity(userKey) {
    this.activity.delete(userKey);
  }
  // Called with every server-sent event; keeps per-user "currently doing X".
  noteEventActivity(event) {
    const t = event?.type;
    const p = event?.properties ?? {};
    if (t === "message.part.updated" && p.part?.type === "tool") {
      const u = this.sessionUser.get(p.part.sessionID);
      if (u) this.setActivity(u, TOOL_LABELS[p.part.tool] ?? `🔧 using ${p.part.tool}…`);
    } else if (t === "message.updated" && p.info?.role === "assistant") {
      const u = this.sessionUser.get(p.info?.sessionID);
      if (u) this.setActivity(u, THINKING);
    } else if (t === "session.status" && p.status?.type && p.status.type !== "idle") {
      const u = this.sessionUser.get(p.sessionID);
      if (u) this.setActivity(u, THINKING);
    } else if (t === "permission.asked") {
      const u = this.sessionUser.get(p.sessionID);
      if (u) this.setActivity(u, "✋ waiting for your approval…");
    }
  }

  isBusy(userKey) { return this.busy.has(userKey); }
  setModel(userKey, m) { this.getState(userKey).model = m; }
  getModel(userKey) { return this.getState(userKey).model || "(opencode default)"; }
  setAgent(userKey, a) { this.getState(userKey).agent = a; }

  // ---------- core prompt (uses ALL tools automatically) ----------
  // Heavy-task safe: fires promptAsync (returns immediately) then polls
  // session.status until idle and reads the answer. No single HTTP request
  // outlives a few seconds, so long runs can't die with "fetch failed".
  // Every poll retries — a loaded server may drop individual requests.
  async sendAndWait(userKey, sessionID, body, { pollMs = 3000, timeoutMs = 45 * 60 * 1000 } = {}) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let beforeIds = new Set();
    try {
      const msgs = unwrap(await this.client.session.messages({ path: { id: sessionID }, query: { limit: 3 } }));
      for (const m of (Array.isArray(msgs) ? msgs : [])) if (m?.info?.id) beforeIds.add(m.info.id);
    } catch {}
    // fire (a failed POST means nothing started server-side, so retrying is safe)
    let sent = false, lastErr = null;
    for (let i = 0; i < 4 && !sent; i++) {
      try {
        unwrap(await this.client.session.promptAsync({ path: { id: sessionID }, body }));
        sent = true;
      } catch (e) { lastErr = e; await sleep(2000 * (i + 1)); }
    }
    if (!sent) throw new Error(`could not reach OpenCode server: ${lastErr?.message ?? lastErr}`);
    const readMessages = async () => {
      try {
        const msgs = unwrap(await this.client.session.messages({ path: { id: sessionID }, query: { limit: 8 } }));
        return Array.isArray(msgs) ? msgs : [];
      } catch { return null; } // transient — caller retries
    };
    // poll until idle AND our answer is visible (guards the start-up race)
    const end = Date.now() + timeoutMs;
    let sawBusy = false, statusErrs = 0;
    while (Date.now() < end) {
      await sleep(pollMs);
      let st = null, statusOk = true;
      try {
        const all = unwrap(await this.client.session.status());
        st = all?.[sessionID] ?? null;
      } catch { statusOk = false; }
      if (!statusOk) {
        if (++statusErrs > 20) throw new Error("lost contact with OpenCode server mid-task — it may still be working; check /messages");
        continue;
      }
      statusErrs = 0;
      if (st && st.type !== "idle") {
        sawBusy = true;
        this.setActivity(userKey, st.type === "retry" ? "🔁 retrying…" : THINKING);
        continue;
      }
      const list = await readMessages();
      if (!list) continue;
      const fresh = list.filter((m) => m?.info?.role === "assistant" && !beforeIds.has(m.info.id));
      if (fresh.length) return this.renderAnswer(fresh[fresh.length - 1]);
      if (sawBusy) {
        const lastAssistant = [...list].reverse().find((m) => m?.info?.role === "assistant");
        if (lastAssistant) return this.renderAnswer(lastAssistant);
        throw new Error("OpenCode finished but left no answer — check /messages");
      }
      // idle but our run hasn't appeared yet (start-up race) — keep waiting
    }
    throw new Error("timed out waiting for OpenCode (45m) — check /messages for partial output");
  }

  renderAnswer(msg) {
    if (msg?.info?.error) throw new Error(errorMessage(msg.info.error));
    const text = extractText({ data: msg });
    if (!text || text === "(empty response from OpenCode)") {
      throw new Error("OpenCode returned an empty answer — check /messages");
    }
    return text;
  }

  async prompt(userKey, text, { noReply = false } = {}) {
    if (this.busy.has(userKey)) throw new Error("Still working on your last message — /abort to cancel.");
    const sessionID = await this.ensureSession(userKey);
    const state = this.getState(userKey);
    this.busy.add(userKey);
    this.setActivity(userKey, THINKING);
    try {
      const model = parseModel(state.model);
      const body = { parts: [{ type: "text", text }] };
      if (model) body.model = model;
      if (state.agent) body.agent = state.agent;
      if (noReply) body.noReply = true;
      if (noReply) {
        unwrap(await this.client.session.promptAsync({ path: { id: sessionID }, body }));
        return "(context saved, no reply requested)";
      }
      return await this.sendAndWait(userKey, sessionID, body);
    } finally {
      this.busy.delete(userKey);
    }
  }

  // ---------- explicit single-tool shortcuts ----------
  // Mutating tools go THROUGH the agent so opencode permissions/hooks/audit
  // behave exactly like the CLI. Read-only tools hit the API directly.
  async useTool(userKey, tool, argsText) {
    const prompts = {
      bash: `Use the bash tool to run this command and return ONLY its output (no extra commentary):\n${argsText}`,
      edit: `Use the edit tool for this change and report what you did (be precise, one edit block):\n${argsText}`,
      write: `Use the write tool for this request and report the file path written:\n${argsText}`,
      apply_patch: `Use the apply_patch tool to apply this patch and report the result:\n${argsText}`,
      skill: `Use the skill tool to load skill "${argsText.trim()}" and summarize what it provides.`,
      todowrite: `Use the todowrite tool for this todo request and show the updated list:\n${argsText}`,
      webfetch: `Use the webfetch tool to fetch this URL and summarize the content:\n${argsText}`,
      websearch: `Use the websearch tool to search for this and summarize the best results:\n${argsText}`,
      question: `The user wants you to ask a clarifying question via the question tool about:\n${argsText}\nIf you have no questions, answer directly instead.`,
      lsp: `Use the lsp tool for this code-intelligence request and return the result:\n${argsText}`,
    };
    if (prompts[tool]) return this.prompt(userKey, prompts[tool]);
    // read/grep/glob handled via fast API path by callers; fallback here:
    return this.prompt(userKey, `Use the ${tool} tool for: ${argsText}\nReturn ONLY the tool result.`);
  }

  // Same as prompt() but with attached files (photos/docs from chat).
  // files: [{ mime, url, filename }] -> FilePartInput; non-image files are
  // additionally referenced by path in the text so the agent can read them.
  async promptWithFiles(userKey, text, files = []) {
    if (this.busy.has(userKey)) throw new Error("Still working on your last message — /abort to cancel.");
    const sessionID = await this.ensureSession(userKey);
    const state = this.getState(userKey);
    this.busy.add(userKey);
    this.setActivity(userKey, THINKING);
    try {
      const model = parseModel(state.model);
      const parts = [
        ...files.map((f) => ({ type: "file", mime: f.mime, url: f.url, filename: f.filename })),
        { type: "text", text },
      ];
      const body = { parts };
      if (model) body.model = model;
      if (state.agent) body.agent = state.agent;
      return await this.sendAndWait(userKey, sessionID, body);
    } finally {
      this.busy.delete(userKey);
    }
  }

  // ---------- fast read-only API paths (no LLM) ----------
  async readFile(relPath) {
    const data = unwrap(await this.client.file.read({ query: { path: relPath } }));
    return typeof data === "string" ? data : (data?.content ?? JSON.stringify(data, null, 2));
  }
  async fileStatus() {
    return unwrap(await this.client.file.status());
  }
  async findText(pattern) {
    return unwrap(await this.client.find.text({ query: { pattern } }));
  }
  async findFiles(query) {
    return unwrap(await this.client.find.files({ query: { query } }));
  }
  async findSymbols(query) {
    return unwrap(await this.client.find.symbols({ query: { query } }));
  }
  async listDir(relPath = ".") {
    return unwrap(await this.client.file.list({ query: { path: relPath } }));
  }

  // ---------- session ops (CLI parity) ----------
  async abort(userKey) {
    const state = this.getState(userKey);
    if (!state.sessionID) return false;
    try {
      unwrap(await this.client.session.abort({ path: { id: state.sessionID } }));
      return true;
    } finally {
      this.busy.delete(userKey);
    }
  }
  async listSessions(limit = 8) {
    const data = unwrap(await this.client.session.list());
    const arr = Array.isArray(data) ? data : [];
    return arr.slice(-limit).reverse();
  }
  async shareSession(userKey) {
    const id = await this.ensureSession(userKey);
    return unwrap(await this.client.session.share({ path: { id } }));
  }
  async unshareSession(userKey) {
    const id = await this.ensureSession(userKey);
    return unwrap(await this.client.session.unshare({ path: { id } }));
  }
  async forkSession(userKey) {
    const id = await this.ensureSession(userKey);
    const forked = unwrap(await this.client.session.fork({ path: { id } })) ?? {};
    if (forked.id) this.getState(userKey).sessionID = forked.id;
    return forked;
  }
  async summarizeSession(userKey) {
    // body (provider/model) omitted -> server default
    const id = await this.ensureSession(userKey);
    return unwrap(await this.client.session.summarize({ path: { id } }));
  }
  async revertSession(userKey, messageID) {
    const id = await this.ensureSession(userKey);
    return unwrap(await this.client.session.revert({ path: { id }, body: { messageID } }));
  }
  async unrevertSession(userKey) {
    const id = await this.ensureSession(userKey);
    return unwrap(await this.client.session.unrevert({ path: { id } }));
  }
  async sessionDiff(userKey) {
    const id = await this.ensureSession(userKey);
    return unwrap(await this.client.session.diff({ path: { id } }));
  }
  async sessionTodo(userKey) {
    const id = await this.ensureSession(userKey);
    return unwrap(await this.client.session.todo({ path: { id } }));
  }
  async sessionMessages(userKey, limit = 10) {
    const id = await this.ensureSession(userKey);
    const msgs = unwrap(await this.client.session.messages({ path: { id }, query: { limit } }));
    return Array.isArray(msgs) ? msgs : [];
  }
  async runShell(userKey, command) {
    // Runs inside the session (visible in transcript, respects config).
    // shell returns a bare AssistantMessage (no parts) -> fetch its parts via messages.
    const id = await this.ensureSession(userKey);
    const state = this.getState(userKey);
    const shellMsg = unwrap(await this.client.session.shell({
      path: { id },
      body: { command, agent: state.agent || "build" },
    }));
    const msgs = unwrap(await this.client.session.messages({ path: { id }, query: { limit: 5 } }));
    const match = (Array.isArray(msgs) ? msgs : []).find((m) => m?.info?.id === shellMsg?.id);
    if (match) return extractText({ data: match });
    return `(shell ran, message ${shellMsg?.id ?? "?"}) — /messages to inspect`;
  }
  async runSlashCommand(userKey, command, args = "") {
    const id = await this.ensureSession(userKey);
    const res = unwrap(await this.client.session.command({
      path: { id },
      body: { command, arguments: args },
    }));
    return extractText({ data: res });
  }
  async answerPermission(userKey, permissionID, response /* once | always | reject */) {
    const id = await this.ensureSession(userKey);
    const map = { allow: "once", always: "always", deny: "reject", reject: "reject", once: "once" };
    // NB: top-level client method in SDK v1.18.x (not client.session.permission)
    return unwrap(await this.client.postSessionIdPermissionsPermissionId({
      path: { id, permissionID },
      body: { response: map[String(response).toLowerCase()] ?? "once" },
    }));
  }

  // ---------- catalog (models/providers/agents/commands/mcp/lsp) ----------
  async listModels() { return unwrap(await this.client.config.providers()); }
  async listAgents() { return unwrap(await this.client.app.agents()); }
  async listCommands() { return unwrap(await this.client.command.list()); }
  async mcpStatus() { return unwrap(await this.client.mcp.status()); }
  async lspStatus() { return unwrap(await this.client.lsp.status()); }
  async formatterStatus() { return unwrap(await this.client.formatter.status()); }
  async getConfig() { return unwrap(await this.client.config.get()); }
  // installed server v1.18.x exposes no /global/health — path.get is the ping
  async health() { return unwrap(await this.client.path.get()); }

  // ---------- raw CLI passthrough: everything else ----------
  // e.g. runCli(["models","anthropic"]), runCli(["stats"]), runCli(["export", id])
  runCli(args, { cwd = process.cwd() } = {}) {
    if (!this.cliEnabled) throw new Error("Raw CLI is disabled (CLI_ENABLED=false).");
    return new Promise((resolve, reject) => {
      // win32: opencode is a shim needing a shell — pass ONE command string (avoids DEP0190)
      const quote = (a) => /[\s"]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a);
      const child = process.platform === "win32"
        ? spawn(`opencode ${args.map(quote).join(" ")}`, { cwd, shell: true })
        : spawn("opencode", args, { cwd });
      let out = "", err = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`opencode ${args[0] || ""} timed out after ${this.cliTimeoutMs}ms`));
      }, this.cliTimeoutMs);
      child.stdout?.on("data", (d) => { out += d; if (out.length > 200000) child.kill(); });
      child.stderr?.on("data", (d) => { err += d; });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out.trim() || "(no output)");
        else reject(new Error(`opencode ${args.join(" ")} exited ${code}: ${(err || out).slice(0, 2000)}`));
      });
    });
  }

  // ---------- realtime events (permissions, session idle, tool calls) ----------
  // Self-healing: the SSE stream drops under heavy server load — reconnect
  // forever with backoff instead of dying silently (which used to kill the
  // activity feed and permission pushes mid-task).
  onEvent(fn) { this.eventHandlers.add(fn); return () => this.eventHandlers.delete(fn); }
  async subscribeEvents(signal) {
    (async () => {
      let attempt = 0;
      while (!signal?.aborted) {
        try {
          const stream = await this.client.event.subscribe();
          attempt = 0;
          for await (const event of stream.stream) {
            if (signal?.aborted) break;
            for (const fn of this.eventHandlers) {
              try { await fn(event); } catch {}
            }
          }
        } catch {}
        if (signal?.aborted) break;
        attempt++;
        await new Promise((r) => setTimeout(r, Math.min(5000 * attempt, 30000)));
      }
    })();
  }

  async close() { try { await this.server?.close?.(); } catch {} }
}
