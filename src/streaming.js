// Native Telegram streaming replies (sendMessageDraft) + Stop button.
// Telegram drafts are ephemeral (~30s) previews; the final answer is always
// delivered as a normal message. Falls back silently on older Bot APIs.
import { telegramApi } from "./net.js";

const THROTTLE_MS = 1000;
const MAX_DRAFT = 4096;

export class Streaming {
  constructor(bot, opencode, chatIdFor) {
    this.bot = bot;
    this.opencode = opencode;
    this.chatIdFor = chatIdFor;
    this.drafts = new Map();     // userKey -> { id, chatId, lastAt, inFlight, timer }
    this.byDraft = new Map();    // draftId -> userKey
    this.seq = 0;
    this.disabled = process.env.TELEGRAM_STREAM === "false";
  }

  register() {
    // Stop presses arrive as a distinct update, often without `from`.
    this.bot.use(async (ctx, next) => {
      const stop = ctx.update?.stopped_message_generation;
      if (!stop) return next();
      const draftId = String(stop.draft_id ?? stop.draftId ?? "");
      const key = this.byDraft.get(draftId);
      if (key) {
        try { await this.opencode.abort(key); } catch {}
        this.clear(key);
        try { await ctx.reply("🛑 Stopped."); } catch {}
      }
    });

    this.opencode.onTextDelta((key, text) => this.onDelta(key, text));
  }

  async begin(key) {
    if (this.disabled) return;
    const chatId = this.chatIdFor(key);
    if (!chatId) return;
    this.clear(key);
    const id = Date.now() * 100 + (++this.seq % 100);
    const d = { id, chatId, lastAt: 0, inFlight: false, timer: null };
    this.drafts.set(key, d);
    this.byDraft.set(String(id), key);
    await this.send(key, "💭 thinking…");
  }

  async onDelta(key, text) {
    const d = this.drafts.get(key);
    if (!d || this.disabled) return;
    d.text = String(text ?? "").slice(0, MAX_DRAFT);
    const remaining = THROTTLE_MS - (Date.now() - d.lastAt);
    if (d.inFlight) return;
    if (remaining > 0) {
      if (!d.timer) d.timer = setTimeout(() => { d.timer = null; this.send(key, d.text).catch(() => {}); }, remaining);
      return;
    }
    await this.send(key, d.text);
  }

  async send(key, text) {
    const d = this.drafts.get(key);
    if (!d || this.disabled) return;
    d.inFlight = true;
    d.lastAt = Date.now();
    try {
      await telegramApi("sendMessageDraft", {
        chat_id: d.chatId,
        draft_id: d.id,
        text: text || "💭 thinking…",
        can_stop: true,
      }, 5000);
    } catch (e) {
      // Older Bot API / clients don't support drafts — disable for this run.
      if (/method not found|unsupported|unknown method/i.test(String(e?.message))) this.disabled = true;
    } finally { d.inFlight = false; }
  }

  clear(key) {
    const d = this.drafts.get(key);
    if (d?.timer) clearTimeout(d.timer);
    if (d) this.byDraft.delete(String(d.id));
    this.drafts.delete(key);
  }
}
