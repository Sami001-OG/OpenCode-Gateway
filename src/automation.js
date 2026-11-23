// Local cron-like scheduler for the gateway. Persists jobs in WORK_DIR and
// delivers results back to the requesting Telegram chat (OpenClaw/Hermes-style).
import fs from "node:fs";
import path from "node:path";

const FILE = ".gateway-schedules.json";

export class Scheduler {
  constructor(dir, run, deliver) {
    this.file = path.join(dir, FILE);
    this.run = run;          // (prompt) => Promise<string>
    this.deliver = deliver;  // (job, text) => Promise<void>
    this.jobs = this.load();
    this.timer = null;
  }
  load() {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return []; }
  }
  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.jobs, null, 2), { mode: 0o600 });
  }
  add(prompt, everyMinutes, chatId, threadId) {
    const job = {
      id: `j${Date.now()}`,
      prompt,
      everyMinutes: Math.max(1, Number(everyMinutes) || 60),
      chatId,
      threadId: threadId || 0,
      nextAt: Date.now() + Math.max(1, Number(everyMinutes) || 60) * 60000,
    };
    this.jobs.push(job);
    this.save();
    return job;
  }
  remove(id) {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.save();
    return this.jobs.length < before;
  }
  list() { return this.jobs; }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), 30000);
    this.timer.unref?.();
  }
  async tick() {
    const now = Date.now();
    for (const job of this.jobs) {
      if (job.nextAt > now) continue;
      job.nextAt = now + job.everyMinutes * 60000;
      this.save();
      try {
        const text = await this.run(job.prompt);
        await this.deliver(job, text);
      } catch (e) {
        await this.deliver(job, `Schedule ${job.id} failed: ${String(e.message).slice(0, 200)}`).catch(() => {});
      }
    }
  }
}
