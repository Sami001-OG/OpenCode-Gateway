// Restart the gateway daemon from the chat. The current process closes its
// OpenCode server, removes its pidfile, spawns a fresh detached daemon using
// the same .env/cwd, then exits. The CLI's start flow writes the new pidfile.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PID_FILE, LOG_FILE, ERR_FILE } from "./daemon.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");

export function scheduleRestart(dir, opencode, delayMs = 1500) {
  setTimeout(async () => {
    try { await opencode.close(); } catch {}
    try { fs.rmSync(path.join(dir, PID_FILE), { force: true }); } catch {}
    let logFd, errFd;
    try {
      logFd = fs.openSync(path.join(dir, LOG_FILE), "a", 0o600);
      errFd = fs.openSync(path.join(dir, ERR_FILE), "a", 0o600);
      fs.chmodSync(path.join(dir, LOG_FILE), 0o600);
      fs.chmodSync(path.join(dir, ERR_FILE), 0o600);
    } catch {}
    const child = spawn(process.execPath, [CLI, "start", "--dir", dir, "--no-ui"], {
      cwd: dir,
      detached: true,
      stdio: ["ignore", logFd ?? "ignore", errFd ?? "ignore"],
      env: { ...process.env },
    });
    child.unref();
    process.exit(0);
  }, delayMs);
}
