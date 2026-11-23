// Lightweight filesystem checkpoints for /checkpoint and /rollback.
import fs from "node:fs";
import path from "node:path";

const DIR = ".gateway-checkpoints";
const SKIP = new Set(["node_modules", ".git", ".telegram-uploads", ".gateway-checkpoints", "node_modules"]);

export class Checkpoints {
  constructor(dir) {
    this.root = dir;
    this.dir = path.join(dir, DIR);
    fs.mkdirSync(this.dir, { recursive: true });
  }
  walk(rel = "", out = []) {
    for (const name of fs.readdirSync(path.join(this.root, rel))) {
      if (SKIP.has(name)) continue;
      const r = rel ? path.join(rel, name) : name;
      const st = fs.lstatSync(path.join(this.root, r));
      if (st.isDirectory()) this.walk(r, out);
      else if (st.isFile() && st.size < 2 * 1024 * 1024) out.push(r);
    }
    return out;
  }
  create(label = "manual") {
    const id = `${Date.now()}_${label.slice(0, 20).replace(/[^\w-]/g, "_")}`;
    const dest = path.join(this.dir, id);
    fs.mkdirSync(dest, { recursive: true });
    const files = this.walk();
    for (const f of files) {
      const to = path.join(dest, f);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(this.root, f), to);
    }
    fs.writeFileSync(path.join(dest, ".files.json"), JSON.stringify(files));
    return id;
  }
  list() { return fs.readdirSync(this.dir).filter((x) => !x.startsWith(".")); }
  restore(id) {
    const src = path.join(this.dir, id);
    if (!fs.existsSync(src) || id.includes("..")) throw new Error("unknown checkpoint");
    const files = JSON.parse(fs.readFileSync(path.join(src, ".files.json"), "utf8"));
    for (const f of files) {
      const to = path.join(this.root, f);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(src, f), to);
    }
    return files.length;
  }
}
