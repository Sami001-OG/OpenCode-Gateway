// Small persistent memory + @context references (Hermes/OpenClaw style).
import fs from "node:fs";
import path from "node:path";

const FILE = "MEMORY.md";
const MAX = 4000;

export class Memory {
  constructor(dir) {
    this.file = path.join(dir, FILE);
  }
  load() {
    try { return fs.readFileSync(this.file, "utf8").trim(); } catch { return ""; }
  }
  remember(text) {
    const line = `- ${String(text).replace(/\s+/g, " ").trim()}`;
    const prev = this.load();
    fs.writeFileSync(this.file, (prev ? prev + "\n" : "# Memory\n") + line + "\n", { mode: 0o600 });
    return line;
  }
  context() {
    const s = this.load();
    return s ? `\n\n[Persistent memory]\n${s.slice(0, MAX)}` : "";
  }
  // Expand @file references from the workspace into the prompt (bounded).
  async expand(text, readFile) {
    const refs = [...String(text).matchAll(/@([\w./-]+\.[A-Za-z0-9]+)/g)].map((m) => m[1]);
    if (!refs.length) return text;
    let out = text;
    for (const ref of refs.slice(0, 5)) {
      try {
        const content = await readFile(ref);
        out += `\n\n[@${ref}]\n${String(content).slice(0, MAX)}`;
      } catch {}
    }
    return out;
  }
}
