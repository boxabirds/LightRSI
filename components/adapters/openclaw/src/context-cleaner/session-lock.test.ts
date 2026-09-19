import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { withOpenClawCleanerSessionLock } from "./session-lock.js";

test("dead process lock is recovered, while an old live process lock is never stolen", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-lock-owner-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const sessionId = "session";
  const key = createHash("sha256").update(sessionId).digest("hex");
  const path = join(stateDir, "context-cleaner", "openclaw-locks", `${key}.lock`);
  await mkdir(dirname(path), { recursive: true });
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true });
  const pid = child.pid;
  assert.ok(pid);
  await once(child, "exit");
  const old = new Date(Date.now() - 60_000);
  await writeFile(path, JSON.stringify({ pid }));
  await utimes(path, old, old);
  const contenders = await Promise.allSettled([0, 1].map(() => withOpenClawCleanerSessionLock({
    stateDir, sessionId,
    action: async () => {
      assert.equal(JSON.parse(await readFile(path, "utf8")).pid, process.pid);
      // Hold ownership across an asynchronous operation to exercise contention.
      await readFile(path, "utf8");
      return "recovered";
    },
  })));
  assert.ok(contenders.some((result) => result.status === "fulfilled"));
  for (const result of contenders) {
    if (result.status === "rejected") assert.match(String(result.reason), /session_busy/);
  }
  await writeFile(path, JSON.stringify({ pid: process.pid }));
  await utimes(path, old, old);
  await assert.rejects(withOpenClawCleanerSessionLock({
    stateDir, sessionId, action: async () => assert.fail("live lock stolen"),
  }), /session_busy/);
});
