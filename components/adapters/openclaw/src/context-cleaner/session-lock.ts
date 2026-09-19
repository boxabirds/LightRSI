import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Shared by OpenClaw commands and all canonical state writers. */
export async function withOpenClawCleanerSessionLock<T>(params: {
  stateDir: string;
  sessionId: string;
  action(): Promise<T>;
}): Promise<T> {
  const key = createHash("sha256").update(params.sessionId).digest("hex");
  const path = join(params.stateDir, "context-cleaner", "openclaw-locks", `${key}.lock`);
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try {
    try {
      handle = await open(path, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Serialize dead-owner recovery so two contenders cannot unlink a newly acquired lock.
      let recovery;
      try {
        recovery = await open(`${path}.reclaim`, "wx");
        let dead = false;
        try {
          const owner = JSON.parse(await readFile(path, "utf8"));
          if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); }
            catch (probe) { dead = (probe as NodeJS.ErrnoException).code === "ESRCH"; }
          }
        } catch { /* Torn or unreadable ownership fails closed. */ }
        // Never expire a live owner's lock, even for a long model/archive call.
        if (!dead || Date.now() - (await stat(path)).mtimeMs < 1_000) {
          throw new Error("openclaw_clean_session_busy");
        }
        await unlink(path);
        handle = await open(path, "wx");
      } catch {
        throw new Error("openclaw_clean_session_busy");
      } finally {
        await recovery?.close();
        if (recovery) await unlink(`${path}.reclaim`);
      }
    }
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return await params.action();
  } finally {
    await handle?.close();
    if (handle) await unlink(path);
  }
}
