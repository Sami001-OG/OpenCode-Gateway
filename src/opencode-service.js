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
import path from "node:path";

// Chat-supplied paths must stay inside WORK_DIR.
export function safePath(relPath) {
  const s = String(relPath ?? "").trim();
  if (!s) throw new Error("Path is required");
  if (path.isAbsolute(s)) throw new Error("Path must be relative to the work directory");
  const abs = path.resolve(process.cwd(), s);
  const root = process.cwd();
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("Path escapes the work directory");
  }
  return s;
}

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
    let data = res.data;
    // v2 servers envelope their payload as { data }, and the v1 SDK wraps that
    // again when pointed at /api. Unwrap only the redundant inner envelope.
    if (data && typeof data === "object" && !Array.isArray(data) &&
        Object.keys(data).length === 1 && "data" in data) data = data.data;
    return data;
  }
  return res;
}

export function parseModel(modelStr, { variantDelimiter = ":" } = {}) {
  if (!modelStr) return undefined;
  const slash = modelStr.indexOf("/");
  if (slash <= 0) return undefined;
  const providerID = modelStr.slice(0, slash).trim();
  if (!providerID) return undefined;
  let modelID = modelStr.slice(slash + 1).trim();
  // v2 uses provider/model#variant; v1 has no variants, so ':' is only a
  // legacy alias there (and may legitimately be part of a model ID like ollama/m:8b).
  const hash = modelID.indexOf("#");
  let idx = hash >= 0 ? hash : (variantDelimiter === ":" ? modelID.lastIndexOf(":") : -1);
  let variant;
  if (idx > 0) {
    variant = modelID.slice(idx + 1).trim();
    modelID = modelID.slice(0, idx).trim();
    if (!variant || variant.includes("#")) return undefined;
  }
  if (!modelID) return undefined;
  return { providerID, modelID, ...(variant ? { variant } : {}) };
}

// cmd.exe: only double quotes neutralise & | > < ^ (and whitespace).
// Embedded quotes are doubled; % and ! still expand, and CR/LF/NUL would
// smuggle a second command — reject those outright. /cli args come from chat.
export function quoteWindowsArg(value) {
  const s = String(value);
  if (/[%!\r\n\0]/.test(s)) {
    throw new Error(`unsafe /cli argument: ${JSON.stringify(s.slice(0, 80))}`);
  }
  return `"${s.replace(/"/g, '""')}"`;
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
    this.textHandlers = new Set(); // streaming text-delta subscribers
    this.lastSeenMessage = new Map(); // sessionID -> newest message id (avoids a pre-POST API call)
    this.streamBuffers = new Map(); // sessionID -> cumulative v2 text delta
    this.lastEventAt = new Map(); // sessionID -> last SSE event time (liveness)
    this.pendingQuestions = new Map(); // userKey -> { sessionID, requestID, fields }
  }

  async init({ serverUrl = "", hostname = "127.0.0.1", port = 4096, timeout = 60000 } = {}) {
    const { createTransport } = await import("./transport.js");
    const t = await createTransport({ serverUrl, hostname, port: Number(port), timeout });
    this.transport = t;
    this.client = t.client;
    this.server = { close: t.close };
    this.apiMode = t.mode;
    // path.get proves we're live on both v1 and v2 (mapped in the v2 adapter).
    const pong = unwrap(await this.client.path.get());
    console.log(`[opencode] ${t.mode.toUpperCase()} server ${serverUrl ? "attached" : "started"} at ${t.url} (cwd=${pong?.cwd ?? "?"})`);
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
    const t = event?.type ?? event?.event;
    // v1 uses `properties`; v2 emits the payload as `data`.
    const p = event?.properties ?? event?.data ?? event?.payload ?? {};
    if (p.sessionID) this.lastEventAt.set(p.sessionID, Date.now());
    // v2 streams incremental text via session.text.* instead of v1 part updates.
    if (t === "session.text.started") {
      this.streamBuffers.set(p.sessionID, "");
    } else if (t === "session.text.delta" && typeof p.delta === "string") {
      const text = (this.streamBuffers.get(p.sessionID) ?? "") + p.delta;
      this.streamBuffers.set(p.sessionID, text);
      const u = this.sessionUser.get(p.sessionID);
      if (u) for (const fn of this.textHandlers) { try { fn(u, text); } catch {} }
    } else if (t === "session.text.ended" && typeof p.text === "string") {
      this.streamBuffers.set(p.sessionID, p.text);
      const u = this.sessionUser.get(p.sessionID);
      if (u) for (const fn of this.textHandlers) { try { fn(u, p.text); } catch {} }
    }
    if (t === "message.part.updated" && p.part?.type === "tool") {
      const u = this.sessionUser.get(p.part.sessionID);
      if (u) this.setActivity(u, TOOL_LABELS[p.part.tool] ?? `🔧 using ${p.part.tool}…`);
    } else if (t === "message.part.updated" && p.part?.type === "text") {
      // Cumulative text — feed streaming drafts (v1 part.text, v2 content blocks).
      const text = p.part?.text ?? (Array.isArray(p.part?.content)
        ? p.part.content.filter((c) => c?.type === "text").map((c) => c.text).join("") : "");
      const u = this.sessionUser.get(p.part.sessionID ?? p.sessionID);
      if (u && typeof text === "string") {
        for (const fn of this.textHandlers) { try { fn(u, text); } catch {} }
      }
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

  // Switch the active session AND keep the session->user map in sync, so live
  // tool/activity labels keep working after /use or /fork.
  switchSession(userKey, target) {
    const st = this.getState(userKey);
    st.sessionID = target.id;
    if (target.title) st.title = String(target.title).replace(/^▶ /, "");
    this.trackSession(userKey, st.sessionID);
    return st;
  }

  // ---------- core prompt (uses ALL tools automatically) ----------
  // Heavy-task safe: fires promptAsync (returns immediately) then polls
  // session.status until idle and reads the answer. No single HTTP request
  // outlives a few seconds, so long runs can't die with "fetch failed".
  // Every poll retries — a loaded server may drop individual requests.
  async sendAndWait(userKey, sessionID, body, { pollMs = 500, timeoutMs = 45 * 60 * 1000 } = {}) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Reuse the last observed message id instead of spending an API round-trip
    // before every prompt. It is refreshed after every message read.
    const beforeId = this.lastSeenMessage.get(sessionID);
    const beforeIds = new Set(beforeId ? [beforeId] : []);
    // A failed POST is NOT proof nothing started: a flaky route can lose the
    // response after the server accepted the prompt. Blindly retrying would run
    // the task twice (two edits, two shell commands). Check whether it landed.
    const promptText = body?.parts?.find?.((p) => p?.type === "text")?.text ?? "";
    const promptLanded = async () => {
      try {
        const all = unwrap(await this.client.session.status());
        const st = all?.[sessionID];
        if (st && st.type !== "idle") return true;
      } catch {}
      try {
        const msgs = unwrap(await this.client.session.messages({ path: { id: sessionID }, query: { limit: 8 } }));
        return (Array.isArray(msgs) ? msgs : []).some((m) =>
          m?.info?.role === "user" && !beforeIds.has(m.info.id) &&
          (m.parts ?? []).some((p) => p?.type === "text" && p.text === promptText)
        );
      } catch { return false; }
    };
    const promptAt = Date.now();
    let sent = false, lastErr = null;
    for (let i = 0; i < 4 && !sent; i++) {
      try {
        unwrap(await this.client.session.promptAsync({ path: { id: sessionID }, body }));
        sent = true;
      } catch (e) {
        lastErr = e;
        if (await promptLanded()) { sent = true; break; } // accepted, reply lost — never re-run
        await sleep(2000 * (i + 1));
      }
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
    let sawBusy = false, statusErrs = 0, quiet = 0, lastSignature = "", firstPoll = true;
    while (Date.now() < end) {
      // Check immediately after the POST — the old fixed 3s sleep before the
      // first poll added a guaranteed multi-second delay to every answer.
      if (firstPoll) firstPoll = false;
      else await sleep(pollMs);
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
      if (list[0]?.info?.id) this.lastSeenMessage.set(sessionID, list[0].info.id);
      // Only assistant messages created after this prompt count. Tracking a
      // single "last id" let older answers be mistaken for the new one.
      const fresh = list.filter((m) => {
        if (m?.info?.role !== "assistant" || beforeIds.has(m.info.id)) return false;
        const created = m?.info?.time?.created;
        return typeof created !== "number" || created >= (promptAt - 2000);
      });
      // v2 sessions can contain assistant records with only tool/reasoning
      // content. Pick the newest one that actually has text instead of failing.
      // v1 returns messages oldest-first, v2 newest-first — sort by timestamp
      // so the newest answer wins regardless of transport ordering.
      const answerWithText = (arr) => [...arr]
        .sort((a, b) => (a?.info?.time?.created ?? 0) - (b?.info?.time?.created ?? 0))
        .reverse()
        .find((m) => (m?.parts ?? []).some((p) => p?.type === "text" && String(p.text ?? "").trim()));
      const pick = answerWithText(fresh);
      if (process.env.GW_DEBUG) console.error("[poll]", JSON.stringify({
        fresh: fresh.length, roles: list.map((m) => m?.info?.role),
        parts: list.map((m) => (m?.parts ?? []).map((p) => p?.type).join(",")),
      }));
      if (pick) return this.renderAnswer(pick);
      if (fresh.length || sawBusy) {
        // v2 streams assistant records: the first one may hold only reasoning
        // or a partial text. Wait until the content stops changing before
        // concluding the agent genuinely returned no text.
        const signature = list.map((m) =>
          `${m?.info?.id}:${(m?.parts ?? []).map((p) => p?.text ?? "").join("")}`).join("|");
        quiet = signature === lastSignature ? quiet + 1 : 0;
        lastSignature = signature;
        // Only give up when the session has gone quiet too — long reasoning can
        // hold a text-less assistant record for many seconds while events still
        // arrive. v2's status endpoint can report idle mid-run, so trust events.
        const lastEvent = this.lastEventAt.get(sessionID) ?? 0;
        const eventQuiet = Date.now() - lastEvent >= 4000;
        if (quiet >= 4 && eventQuiet && Date.now() - promptAt >= 5000) {
          return "(OpenCode finished but returned no text — check /messages for tool activity)";
        }
        continue;
      }
      quiet = 0;
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
      const model = parseModel(state.model, { variantDelimiter: this.apiMode === "v2" ? "#" : ":" });
      const body = { parts: [{ type: "text", text }] };
      if (model) body.model = model;
      if (model?.variant) body.variant = model.variant;
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

  // Lightweight, stateless prompt used by Telegram inline mode.
  async inlinePrompt(text, { timeoutMs = 8000 } = {}) {
    const k = "inline:" + Date.now();
    const sessionID = await this.newSession(k, "inline");
    const model = parseModel(process.env.INLINE_MODEL ?? "");
    const body = { parts: [{ type: "text", text: `Answer briefly (max 60 words):\n${text}` }] };
    if (model) body.model = model;
    try {
      return await this.sendAndWait(k, sessionID, body, { pollMs: 500, timeoutMs });
    } finally {
      this.sessions.delete(k);
      this.sessionUser.delete(sessionID);
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
      const model = parseModel(state.model, { variantDelimiter: this.apiMode === "v2" ? "#" : ":" });
      const parts = [
        ...files.map((f) => ({ type: "file", mime: f.mime, url: f.url, filename: f.filename })),
        { type: "text", text },
      ];
      const body = { parts };
      if (model) body.model = model;
      if (model?.variant) body.variant = model.variant;
      if (state.agent) body.agent = state.agent;
      return await this.sendAndWait(userKey, sessionID, body);
    } finally {
      this.busy.delete(userKey);
    }
  }

  // ---------- fast read-only API paths (no LLM) ----------
  async readFile(relPath) {
    const data = unwrap(await this.client.file.read({ query: { path: safePath(relPath) } }));
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
    return unwrap(await this.client.file.list({ query: { path: safePath(relPath) } }));
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
    if (forked.id) this.switchSession(userKey, forked);
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
  async answerPermission(userKey, permissionID, response /* once | always | reject */, sessionID = "") {
    // Reply into the session that ASKED, not the clicker's current session.
    const id = sessionID || await this.ensureSession(userKey);
    const map = { allow: "once", always: "always", deny: "reject", reject: "reject", once: "once" };
    const reply = map[String(response).toLowerCase()] ?? "once";
    if (this.apiMode === "v2" && this.transport?.raw) {
      await this.transport.raw(`/session/${encodeURIComponent(id)}/permission/${encodeURIComponent(permissionID)}/reply`, {
        method: "POST", body: { reply },
      });
      return true;
    }
    // NB: top-level client method in SDK v1.18.x (not client.session.permission)
    return unwrap(await this.client.postSessionIdPermissionsPermissionId({
      path: { id, permissionID },
      body: { response: reply },
    }));
  }

  // ---------- question / form tool (agent asks the user) ----------
  async answerQuestion(userKey, answers) {
    const q = this.pendingQuestions.get(userKey);
    if (!q) throw new Error("No pending question");
    this.pendingQuestions.delete(userKey);
    if (this.apiMode === "v2" && this.transport?.raw) {
      // v2 forms: { answer: { q0: "label" | ["a","b"], ... } }
      const answer = {};
      q.fields.forEach((f, i) => {
        const v = answers[i];
        answer[f.key ?? `q${i}`] = f.multiple ? v : (Array.isArray(v) ? v[0] : v);
      });
      await this.transport.raw(`/session/${encodeURIComponent(q.sessionID)}/form/${encodeURIComponent(q.requestID)}/reply`, {
        method: "POST", body: { answer },
      });
      return true;
    }
    // v1: POST /question/:requestID/reply { answers: string[][] }
    const url = this.transport?.url ?? "";
    const res = await fetch(`${url}/question/${encodeURIComponent(q.requestID)}/reply`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers }), signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`question reply failed: ${res.status}`);
    return true;
  }
  async rejectQuestion(userKey) {
    const q = this.pendingQuestions.get(userKey);
    if (!q) return false;
    this.pendingQuestions.delete(userKey);
    try {
      if (this.apiMode === "v2" && this.transport?.raw) {
        await this.transport.raw(`/session/${encodeURIComponent(q.sessionID)}/form/${encodeURIComponent(q.requestID)}`, { method: "DELETE" });
      } else {
        await fetch(`${this.transport?.url ?? ""}/question/${encodeURIComponent(q.requestID)}/reject`, {
          method: "POST", signal: AbortSignal.timeout(15000),
        });
      }
    } catch {}
    return true;
  }

  // ---------- v2-only catalogs (skills, worktrees) ----------
  async listSkills() {
    if (this.apiMode !== "v2" || !this.transport?.raw) throw new Error("/skills is only available on OpenCode v2 servers");
    const r = await this.transport.raw("/skill");
    const arr = Array.isArray(r?.data) ? r.data : [];
    return arr.map((s) => ({ name: s.name ?? s.id, description: s.description ?? "", slash: s.slash }));
  }
  async listWorktrees() {
    if (this.apiMode !== "v2" || !this.transport?.raw) throw new Error("/worktree is only available on OpenCode v2 servers");
    const r = await this.transport.raw("/experimental/worktree");
    return Array.isArray(r?.data) ? r.data : [];
  }
  async createWorktree(name) {
    if (this.apiMode !== "v2" || !this.transport?.raw) throw new Error("/worktree is only available on OpenCode v2 servers");
    const r = await this.transport.raw("/experimental/worktree", { method: "POST", body: { name } });
    return r?.data ?? {};
  }
  async removeWorktree(directory) {
    if (this.apiMode !== "v2" || !this.transport?.raw) throw new Error("/worktree is only available on OpenCode v2 servers");
    await this.transport.raw("/experimental/worktree", { method: "DELETE", body: { directory } });
    return true;
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
      // win32: opencode is a .cmd shim and needs cmd.exe. Quote every argument
      // so chat-supplied metacharacters (& | > < ^) stay literal.
      const child = process.platform === "win32"
        ? spawn(`opencode ${args.map(quoteWindowsArg).join(" ")}`, {
            cwd, shell: true, windowsVerbatimArguments: true,
          })
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
  onTextDelta(fn) { this.textHandlers.add(fn); return () => this.textHandlers.delete(fn); }
  async subscribeEvents(signal) {
    (async () => {
      let attempt = 0;
      while (!signal?.aborted) {
        try {
          const stream = await this.client.event.subscribe({ signal });
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
