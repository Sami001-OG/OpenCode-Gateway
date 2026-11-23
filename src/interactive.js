// Interactive Telegram UI: inline keyboards, pagination and callback routing.
// Keeps callback_data short (Telegram's 64-byte limit) by storing the actual
// lists per user and putting only a short index in the button payload.
import { Markup } from "telegraf";
import { BUILTIN_TOOLS } from "./opencode-service.js";

const PAGE = 8;
const btn = (text, data) => Markup.button.callback(text, data);
const kb = (rows) => Markup.inlineKeyboard(rows);
const short = (s, n = 26) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

export function normalizeProviders(data) {
  const arr = data?.providers ?? (Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []);
  return (Array.isArray(arr) ? arr : []).map((p) => ({
    id: p.id,
    name: p.name ?? p.id,
    models: Array.isArray(p.models)
      ? p.models.map((m) => ({
          id: typeof m === "string" ? m : (m.id ?? m.modelID),
          modelID: typeof m === "string" ? m : (m.modelID ?? m.id),
          name: typeof m === "string" ? m : (m.name ?? m.id ?? m.modelID),
          variants: typeof m === "string" ? [] : (m.variants ?? []).map((x) => (typeof x === "string" ? x : x.id)).filter(Boolean),
        }))
      : Object.entries(p.models ?? {}).map(([k, v]) => ({
          id: v?.id ?? k, name: v?.name ?? k, modelID: v?.modelID ?? k,
          variants: (v?.variants ?? []).map((x) => (typeof x === "string" ? x : x.id)).filter(Boolean),
        })),
  }));
}

export class TelegramUI {
  constructor(bot, opencode, keyFn) {
    this.bot = bot;
    this.opencode = opencode;
    this.key = keyFn;
    this.state = new Map();
    this.permTokens = new Map(); // short token -> { userKey, permissionID }
    this.tokenSeq = 0;
  }

  get(k) {
    if (!this.state.has(k)) {
      this.state.set(k, { menu: "main", pages: {}, lists: {}, model: "", agent: "" });
    }
    return this.state.get(k);
  }

  // ---------- rendering ----------
  async edit(ctx, text, markup) {
    try {
      if (ctx.callbackQuery) await ctx.editMessageText(text, markup);
      else await ctx.reply(text, markup);
    } catch (e) {
      if (/not modified/i.test(String(e?.message))) return;
      try { await ctx.reply(text, markup); } catch {}
    }
  }

  async present(ctx, menu, extra = {}) {
    const k = this.key(ctx);
    const s = this.get(k);
    s.menu = menu;
    if (extra.page !== undefined) s.pages[menu] = extra.page;
    const view = await this.view(k, menu);
    const markup = kb(view.rows);
    const text = `${view.text}\n\n${s.menu !== "main" ? "⬇️ choose below · /menu for main menu" : "Tap a category:"}`;
    try {
      if (ctx.callbackQuery) {
        await ctx.editMessageText(text, markup);
      } else {
        await ctx.reply(text, markup);
      }
    } catch (e) {
      if (/not modified/i.test(String(e.message))) {
        try { await ctx.answerCbQuery(); } catch {}
      } else {
        try { await ctx.reply(text, markup); } catch {}
      }
    }
  }

  async view(k, menu) {
    const s = this.get(k);
    switch (menu) {
      case "main":
        return {
          text: `📱 *OpenCode gateway*\nworkdir: \`${process.cwd()}\`\nmodel: ${this.opencode.getModel(k)}`,
          rows: [
            [btn("💬 Sessions", "nav:sessions"), btn("🧠 Models", "nav:models")],
            [btn("🤖 Agents", "nav:agents"), btn("🔧 Tools", "nav:tools")],
            [btn("⚙️ System", "nav:system"), btn("📋 Commands", "nav:commands")],
            [btn("🌐 Providers", "nav:providers"), btn("❌ Close", "act:close")],
            ...(process.env.TELEGRAM_MINIAPP_URL
              ? [[Markup.button.webApp("🚀 Open App", process.env.TELEGRAM_MINIAPP_URL)]] : []),
          ],
        };
      case "models": {
        const all = s.lists.models ?? [];
        const page = Math.min(s.pages[menu] ?? 0, Math.max(0, Math.ceil(all.length / PAGE) - 1));
        s.pages[menu] = page;
        const items = all.slice(page * PAGE, (page + 1) * PAGE);
        const rows = items.map((m, i) => [btn(short(m.name || m.id), `sel:model:${page * PAGE + i}`)]);
        rows.push(this.pager("models", page, all.length));
        rows.push([btn("« Main", "nav:main")]);
        return { text: `🧠 *Models* (${all.length}) — pick one to use for this chat`, rows };
      }
      case "agents": {
        const all = s.lists.agents ?? [];
        const page = Math.min(s.pages[menu] ?? 0, Math.max(0, Math.ceil(all.length / PAGE) - 1));
        s.pages[menu] = page;
        const items = all.slice(page * PAGE, (page + 1) * PAGE);
        const rows = items.map((a, i) => [btn(short(a.name), `sel:agent:${page * PAGE + i}`)]);
        if (!rows.length) rows.push([btn("(no agents configured)", "noop")]);
        rows.push(this.pager("agents", page, all.length));
        rows.push([btn("« Main", "nav:main")]);
        return { text: `🤖 *Agents* (${all.length})`, rows };
      }
      case "sessions": {
        const all = s.lists.sessions ?? [];
        const rows = all.slice(0, 10).map((x, i) => [btn(short(`${i + 1}. ${x.title || x.id}`), `sel:session:${i}`)]);
        if (!rows.length) rows.push([btn("(no sessions yet)", "noop")]);
        rows.push([btn("➕ New session", "act:new"), btn("« Main", "nav:main")]);
        return { text: "💬 *Sessions* — switch by tapping", rows };
      }
      case "providers": {
        const all = s.lists.providers ?? [];
        const rows = all.map((p, i) => [btn(short(`${p.name ?? p.id} (${(p.models ?? []).length})`), `sel:provider:${i}`)]);
        if (!rows.length) rows.push([btn("(no providers)", "noop")]);
        rows.push([btn("« Main", "nav:main")]);
        return { text: `🌐 *Providers* (${all.length})`, rows };
      }
      case "commands": {
        const all = s.lists.commands ?? [];
        const page = Math.min(s.pages[menu] ?? 0, Math.max(0, Math.ceil(all.length / PAGE) - 1));
        s.pages[menu] = page;
        const items = all.slice(page * PAGE, (page + 1) * PAGE);
        const rows = items.map((c, i) => [btn(short("/" + (c.name ?? c)), `hint:command:${page * PAGE + i}`)]);
        if (!rows.length) rows.push([btn("(none reported)", "noop")]);
        rows.push(this.pager("commands", page, all.length));
        rows.push([btn("« Main", "nav:main")]);
        return { text: "📋 *OpenCode slash commands*", rows };
      }
      case "tools": {
        const rows = [];
        const denied = new Set((process.env.TOOL_POLICY_DENY || "").split(",").map((x) => x.trim()));
        const entries = BUILTIN_TOOLS.map((t, i) => ({ t, i })).filter((x) => !denied.has(x.t));
        for (let j = 0; j < entries.length; j += 2) {
          rows.push([
            btn(entries[j].t, `hint:tool:${entries[j].i}`),
            ...(entries[j + 1] ? [btn(entries[j + 1].t, `hint:tool:${entries[j + 1].i}`)] : []),
          ]);
        }
        rows.push([btn("« Main", "nav:main")]);
        return { text: "🔧 *Built-in tools* — tap for usage", rows };
      }
      case "system":
        return {
          text: "⚙️ *System*",
          rows: [
            [btn("📊 Status", "run:status"), btn("🩺 Health", "run:health")],
            [btn("📈 Stats", "run:stats"), btn("⚙️ Config", "run:config")],
            [btn("🔌 MCP", "run:mcp"), btn("🔬 LSP", "run:lspstatus")],
            [btn("🛑 Abort", "act:abort"), btn("🗑 Unshare", "run:unshare")],
            [btn("« Main", "nav:main")],
          ],
        };
      default:
        return { text: "Unknown menu", rows: [[btn("« Main", "nav:main")]] };
    }
  }

  pager(menu, page, total) {
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const row = [];
    if (page > 0) row.push(btn("◀ Prev", `page:${menu}:-1`));
    row.push(btn(`${page + 1}/${pages}`, "noop"));
    if (page < pages - 1) row.push(btn("Next ▶", `page:${menu}:1`));
    return row;
  }

  // ---------- entry points ----------
  async main(ctx) { await this.present(ctx, "main"); }

  async refreshLists(k) {
    const s = this.get(k);
    try {
      const data = await this.opencode.listModels();
      s.lists.providers = normalizeProviders(data);
      s.lists.models = s.lists.providers.flatMap((p) =>
        (p.models ?? []).map((m) => ({
          id: `${p.id}/${m.id ?? m.modelID}`,
          name: `${p.id}/${m.name ?? m.id ?? m.modelID}`,
          variants: m.variants ?? [],
        })));
    } catch {}
    try {
      const list = await this.opencode.listAgents();
      s.lists.agents = (Array.isArray(list) ? list : list?.data ?? []).map((a) =>
        typeof a === "string" ? { name: a } : a);
    } catch {}
    try { s.lists.sessions = await this.opencode.listSessions(20); } catch {}
    try {
      const list = await this.opencode.listCommands();
      s.lists.commands = (Array.isArray(list) ? list : list?.data ?? []).map((c) =>
        typeof c === "string" ? { name: c } : c);
    } catch {}
  }

  async show(ctx, menu) {
    const k = this.key(ctx);
    await this.refreshLists(k);
    this.get(k).pages[menu] = 0;
    await this.present(ctx, menu);
  }

  permissionKeyboard(permissionID, ownerKeys = []) {
    const now = Date.now();
    for (const [t, e] of this.permTokens) {
      if (!e || e.expires < now) this.permTokens.delete(t);
    }
    const token = `p${++this.tokenSeq}`;
    this.permTokens.set(token, {
      permissionID,
      owners: new Set(ownerKeys.map(String)),
      expires: now + 10 * 60 * 1000,
    });
    return kb([
      [btn("✅ Allow once", `prm:${token}:y`), btn("♾ Always", `prm:${token}:a`)],
      [btn("❌ Deny", `prm:${token}:n`)],
    ]);
  }

  // ---------- callback router ----------
  register() {
    this.bot.on("callback_query", async (ctx) => {
      try { await ctx.answerCbQuery(); } catch {}
      const data = ctx.callbackQuery?.data ?? "";
      const k = this.key(ctx);
      const s = this.get(k);
      const [kind, ...rest] = data.split(":");
      try {
        if (kind === "nav") return await this.show(ctx, rest[0] || "main");
        if (kind === "page") {
          s.pages[rest[0]] = Math.max(0, (s.pages[rest[0]] ?? 0) + Number(rest[1]));
          return await this.present(ctx, rest[0]);
        }
        if (kind === "noop") return;
        if (kind === "act") return await this.action(ctx, rest[0]);
        if (kind === "run") return await this.run(ctx, rest[0]);
        if (kind === "hint") return await this.hint(ctx, rest[0], Number(rest[1]));
        if (kind === "sel") return await this.select(ctx, rest[0], Number(rest[1]));
        if (kind === "var") return await this.variant(ctx, Number(rest[0]));
        if (kind === "prm") {
          const entry = this.permTokens.get(rest[0]);
          if (!entry || entry.expires < Date.now() ||
              (entry.owners.size && !entry.owners.has(k))) {
            return ctx.answerCbQuery("Not authorized or expired", { show_alert: true });
          }
          this.permTokens.delete(rest[0]); // single-use
          const response = rest[1] === "y" ? "allow" : rest[1] === "a" ? "always" : "deny";
          await this.opencode.answerPermission(k, entry.permissionID, response);
          const label = { allow: "✅ Allowed once", always: "♾ Always allowed", deny: "❌ Denied" }[response];
          await this.edit(ctx, label);
        }
      } catch (e) {
        try { await ctx.reply(`Error: ${String(e.message).slice(0, 300)}`); } catch {}
      }
    });
  }

  async select(ctx, kind, index) {
    const k = this.key(ctx);
    const s = this.get(k);
    // callback payloads use singular kinds; state stores plural lists
    const plural = { model: "models", agent: "agents", session: "sessions", provider: "providers" }[kind] ?? kind;
    const list = s.lists[plural] ?? [];
    const item = list[index];
    if (!item) return;
    if (kind === "model") {
      s.pendingModel = item;
      const variants = item.variants ?? [];
      if (variants.length) {
        const rows = variants.map((v, i) => [btn(v, `var:${i}`)]);
        rows.push([btn("Default (no variant)", "var:-1")]);
        rows.push([btn("« Models", "nav:models")]);
        return ctx.editMessageText(`🧠 \`${item.id}\`\nPick a variant:`, kb(rows));
      }
      this.opencode.setModel(k, item.id);
      s.model = item.id;
      await ctx.editMessageText(`✅ Model: \`${item.id}\``, kb([[btn("🧠 Models", "nav:models"), btn("« Main", "nav:main")]]));
    } else if (kind === "agent") {
      this.opencode.setAgent(k, item.name);
      s.agent = item.name;
      await ctx.editMessageText(`✅ Agent: ${item.name}`, kb([[btn("🤖 Agents", "nav:agents"), btn("« Main", "nav:main")]]));
    } else if (kind === "session") {
      this.opencode.switchSession(k, item);
      await ctx.editMessageText(`✅ Switched to "${item.title || item.id}"`, kb([[btn("💬 Sessions", "nav:sessions"), btn("« Main", "nav:main")]]));
    } else if (kind === "provider") {
      s.lists.models = (item.models ?? []).map((m) => ({
        id: `${item.id}/${m.id ?? m.modelID}`,
        name: `${item.id}/${m.name ?? m.id ?? m.modelID}`,
        variants: m.variants ?? [],
      }));
      s.pages.models = 0;
      await this.present(ctx, "models");
    }
  }

  async variant(ctx, index) {
    const k = this.key(ctx);
    const s = this.get(k);
    const m = s.pendingModel;
    if (!m) return;
    const v = index < 0 ? "" : (m.variants ?? [])[index];
    const id = v ? `${m.id}#${v}` : m.id;
    this.opencode.setModel(k, id);
    s.model = id;
    s.pendingModel = null;
    await ctx.editMessageText(`✅ Model: \`${id}\``, kb([
      [btn("🧠 Models", "nav:models"), btn("« Main", "nav:main")],
    ]));
  }

  async hint(ctx, kind, index) {
    if (kind === "tool") {
      const tool = BUILTIN_TOOLS[index];
      const usage = {
        bash: "/bash <command>", read: "/read <path>", edit: "/edit <path> :: <old> :: <new>",
        write: "/write <path> :: <content>", grep: "/grep <regex>", glob: "/glob <pattern>",
        lsp: "/lsp hover file:line:col", webfetch: "/webfetch <url>", websearch: "/websearch <query>",
        skill: "/skill <name>", todowrite: "/todoadd <text>", question: "/ask <topic>",
      };
      return ctx.editMessageText(`🔧 \`${tool}\`\nusage: \`${usage[tool] ?? "/<tool> <args>"}\`\n\nOr just describe the task in plain chat.`, kb([[btn("« Tools", "nav:tools")]]));
    }
    const c = this.get(this.key(ctx)).lists.commands?.[index];
    await ctx.editMessageText(`📋 \`/${c?.name ?? "?"}\` — ${short(c?.description ?? "", 160)}`, kb([[btn("« Commands", "nav:commands")]]));
  }

  async action(ctx, name) {
    const k = this.key(ctx);
    if (name === "close") return ctx.editMessageText("Menu closed. /menu to reopen.");
    if (name === "abort") {
      await this.opencode.abort(k);
      return ctx.editMessageText("🛑 Aborted.", kb([[btn("« Main", "nav:main")]]));
    }
    if (name === "new") {
      const id = await this.opencode.newSession(k, "telegram");
      return ctx.editMessageText(`➕ New session: \`${id}\``, kb([[btn("💬 Sessions", "nav:sessions")]]));
    }
  }

  async run(ctx, command) {
    const k = this.key(ctx);
    const out = {
      status: () => `dir: ${process.cwd()}\nsession: ${this.opencode.getState(k).sessionID ?? "none"}\nmodel: ${this.opencode.getModel(k)}`,
      health: async () => JSON.stringify(await this.opencode.health()),
      stats: async () => this.opencode.runCli(["stats"]),
      config: async () => JSON.stringify(await this.opencode.getConfig()),
      mcp: async () => JSON.stringify(await this.opencode.mcpStatus()),
      lspstatus: async () => JSON.stringify(await this.opencode.lspStatus()),
      unshare: async () => JSON.stringify(await this.opencode.unshareSession(k)),
    }[command];
    const text = out ? String(await out()).slice(0, 3500) : "Unknown action";
    await ctx.editMessageText(text, kb([[btn("⚙️ System", "nav:system"), btn("« Main", "nav:main")]]));
  }
}
