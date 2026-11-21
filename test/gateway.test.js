// Behavioural tests for the gateway's high-risk paths.
// No network, no opencode CLI, no Telegram token required — all I/O is faked.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { OpencodeService, quoteWindowsArg } from "../src/opencode-service.js";
import { COMMANDS } from "../src/commands.js";
import { isTermux, authHeaders, normalizeMessage, createTransport } from "../src/transport.js";

const user = "42";
const sid = "ses_x";
const oldMsg = () => ({
  info: { id: "m_old", role: "user" },
  parts: [{ type: "text", text: "old" }],
});

test("switchSession keeps the session->user map in sync (live activity after /use)", () => {
  const svc = new OpencodeService();
  svc.trackSession(user, "ses_old");
  assert.equal(svc.sessionUser.get("ses_old"), user);

  const st = svc.switchSession(user, { id: "ses_new", title: "▶ Fix login" });
  assert.equal(st.sessionID, "ses_new");
  assert.equal(st.title, "Fix login"); // ▶ marker stripped
  assert.equal(svc.sessionUser.get("ses_new"), user);
  assert.equal(svc.sessionUser.has("ses_old"), true); // old mapping harmless
});

test("forkSession tracks the new session id", async () => {
  const svc = new OpencodeService();
  svc.client = {
    session: {
      create: async () => ({ data: { id: "ses_old" } }),
      fork: async () => ({ data: { id: "ses_forked" } }),
    },
  };
  svc.sessions.set(user, { sessionID: "ses_old", title: "telegram", model: "", agent: "" });
  svc.trackSession(user, "ses_old");

  const forked = await svc.forkSession(user);
  assert.equal(forked.id, "ses_forked");
  assert.equal(svc.getState(user).sessionID, "ses_forked");
  assert.equal(svc.sessionUser.get("ses_forked"), user);
});

test("sendAndWait does NOT re-post when the server accepted the prompt but the reply was lost", async () => {
  const svc = new OpencodeService();
  let posts = 0, landed = false, statusCalls = 0;
  svc.client = {
    session: {
      messages: async () => landed
        ? [oldMsg(),
           { info: { id: "m_new", role: "user" }, parts: [{ type: "text", text: "do it" }] },
           { info: { id: "m_ans", role: "assistant" }, parts: [{ type: "text", text: "done" }] }]
        : [oldMsg()],
      promptAsync: async () => {
        posts++;
        landed = true;              // server started the run...
        throw new Error("fetch failed"); // ...but the HTTP response vanished
      },
      status: async () => {
        statusCalls++;
        return { [sid]: { type: landed && statusCalls <= 2 ? "busy" : "idle" } };
      },
    },
  };

  const answer = await svc.sendAndWait(
    user, sid, { parts: [{ type: "text", text: "do it" }] },
    { pollMs: 1, timeoutMs: 500 }
  );
  assert.equal(posts, 1, "must not run the task twice");
  assert.equal(answer, "done");
});

test("sendAndWait retries when the POST genuinely failed", async () => {
  const svc = new OpencodeService();
  let posts = 0;
  svc.client = {
    session: {
      messages: async () => posts >= 2
        ? [oldMsg(), { info: { id: "m_ans", role: "assistant" }, parts: [{ type: "text", text: "ok" }] }]
        : [oldMsg()],
      promptAsync: async () => { posts++; if (posts === 1) throw new Error("ECONNRESET"); },
      status: async () => ({ [sid]: { type: "idle" } }),
    },
  };

  const answer = await svc.sendAndWait(
    user, sid, { parts: [{ type: "text", text: "go" }] },
    { pollMs: 1, timeoutMs: 500 }
  );
  assert.equal(posts, 2, "a real failure should still be retried");
  assert.equal(answer, "ok");
});

test("quoteWindowsArg makes chat-supplied /cli args shell-safe", () => {
  assert.equal(quoteWindowsArg("&calc"), '"&calc"');
  assert.equal(quoteWindowsArg("a|b>c"), '"a|b>c"');
  assert.equal(quoteWindowsArg('say "hi"'), '"say ""hi"""');
  assert.throws(() => quoteWindowsArg("x%PATH%"), /unsafe/);
  assert.throws(() => quoteWindowsArg("a\nb"), /unsafe/);
  assert.throws(() => quoteWindowsArg("a!b"), /unsafe/);
});

test("Termux detection works without breaking other platforms", () => {
  const saved = { tv: process.env.TERMUX_VERSION, prefix: process.env.PREFIX };
  try {
    delete process.env.TERMUX_VERSION; delete process.env.PREFIX;
    assert.equal(isTermux(), false);
    process.env.TERMUX_VERSION = "googleplay.2026.10.09";
    assert.equal(isTermux(), true);
    delete process.env.TERMUX_VERSION;
    process.env.PREFIX = "/data/data/com.termux/files/usr";
    assert.equal(isTermux(), true);
  } finally {
    if (saved.tv === undefined) delete process.env.TERMUX_VERSION; else process.env.TERMUX_VERSION = saved.tv;
    if (saved.prefix === undefined) delete process.env.PREFIX; else process.env.PREFIX = saved.prefix;
  }
});

test("v2 transport sends Basic auth + directory header", () => {
  const h = authHeaders("secret");
  assert.equal(h.Authorization, "Basic " + Buffer.from("opencode:secret").toString("base64"));
  assert.equal(h["x-opencode-directory"], encodeURIComponent(process.cwd()));
  assert.equal(authHeaders("")["x-opencode-directory"], encodeURIComponent(process.cwd()));
});

test("v2 messages map into the v1 shape the gateway renders", () => {
  const m = normalizeMessage({
    id: "msg_1", type: "assistant",
    content: [
      { type: "reasoning", text: "PRIVATE REASONING" },
      { type: "text", text: "hello" },
      { type: "tool", id: "t1" },
    ],
  });
  assert.equal(m.info.id, "msg_1");
  assert.equal(m.info.role, "assistant");
  assert.equal(m.parts.length, 1, "reasoning/tools must not reach the user");
  assert.equal(m.parts[0].text, "hello");
  assert.ok(!JSON.stringify(m).includes("PRIVATE REASONING"));
});

test("transport auto-detects v1 vs v2 servers", async () => {
  const listen = (status) => new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/api/session") {
        res.writeHead(status, { "content-type": "application/json" });
        res.end("[]");
      } else { res.writeHead(404); res.end(); }
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  const v1 = await listen(404);
  const v2 = await listen(200);
  try {
    const t1 = await createTransport({ serverUrl: `http://127.0.0.1:${v1.address().port}` });
    const t2 = await createTransport({ serverUrl: `http://127.0.0.1:${v2.address().port}` });
    assert.equal(t1.mode, "v1");
    assert.equal(t2.mode, "v2");
  } finally {
    v1.close(); v2.close();
  }
});

test("canonical Telegram menu stays in sync with registered handlers", () => {
  const src = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const handlers = [...src.matchAll(/bot\.command\("([^"]+)"/g)].map((m) => m[1]);
  const menu = COMMANDS.map(([name]) => name);
  const telegrafBuiltins = new Set(["start", "help"]); // bot.start() / bot.help()

  const expected = menu.filter((c) => !telegrafBuiltins.has(c)).sort();
  assert.deepEqual(handlers.sort(), expected);
  assert.equal(new Set(menu).size, menu.length, "duplicate commands in menu");
});
