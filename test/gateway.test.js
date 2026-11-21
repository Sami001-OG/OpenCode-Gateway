// Behavioural tests for the gateway's high-risk paths.
// No network, no opencode CLI, no Telegram token required — all I/O is faked.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { OpencodeService, quoteWindowsArg } from "../src/opencode-service.js";
import { COMMANDS } from "../src/commands.js";

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

test("canonical Telegram menu stays in sync with registered handlers", () => {
  const src = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const handlers = [...src.matchAll(/bot\.command\("([^"]+)"/g)].map((m) => m[1]);
  const menu = COMMANDS.map(([name]) => name);
  const telegrafBuiltins = new Set(["start", "help"]); // bot.start() / bot.help()

  const expected = menu.filter((c) => !telegrafBuiltins.has(c)).sort();
  assert.deepEqual(handlers.sort(), expected);
  assert.equal(new Set(menu).size, menu.length, "duplicate commands in menu");
});
