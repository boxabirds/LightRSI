import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
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
      const currentOwner = JSON.parse(await readFile(path, "utf8"));
      assert.equal(currentOwner.pid, process.pid);
      assert.equal(JSON.parse(await readFile(`${path}.reclaim`, "utf8")).ownerId,
        currentOwner.ownerId);
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

test("recovers a stale reclaim guard left by a dead process", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-reclaim-owner-"));
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
  await writeFile(`${path}.reclaim`, JSON.stringify({ pid }));
  await utimes(path, old, old);
  await utimes(`${path}.reclaim`, old, old);

  let active = 0;
  let maxActive = 0;
  const contenders = await Promise.allSettled(Array.from({ length: 8 }, () =>
    withOpenClawCleanerSessionLock({
      stateDir,
      sessionId,
      action: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
        return "recovered";
      },
    })));
  assert.equal(contenders.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(maxActive, 1);
});

test("does not recover an old lock whose owner cannot be identified", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-unknown-owner-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const sessionId = "session";
  const key = createHash("sha256").update(sessionId).digest("hex");
  const path = join(stateDir, "context-cleaner", "openclaw-locks", `${key}.lock`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "");
  const old = new Date(Date.now() - 60_000);
  await utimes(path, old, old);

  await assert.rejects(withOpenClawCleanerSessionLock({
    stateDir, sessionId, action: async () => assert.fail("unknown owner lock stolen"),
  }), /session_busy/);
});

test("does not unlink a fresh owner after the observed main lock disappears", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-missing-owner-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const sessionId = "session";
  const key = createHash("sha256").update(sessionId).digest("hex");
  const path = join(stateDir, "context-cleaner", "openclaw-locks", `${key}.lock`);
  await mkdir(dirname(path), { recursive: true });
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true });
  const pid = child.pid;
  assert.ok(pid);
  await once(child, "exit");
  await writeFile(path, JSON.stringify({ pid }));
  const old = new Date(Date.now() - 60_000);
  await utimes(path, old, old);

  const attempt = withOpenClawCleanerSessionLock({
    stateDir, sessionId, action: async () => "stolen",
  });
  const candidateDir = `${path}.reclaimers`;
  while ((await readdir(candidateDir).catch(() => [])).length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await unlink(path);
  await assert.rejects(attempt, /session_busy/);
});

test("does not let a later candidate outrank an active recovery owner", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-election-owner-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const sessionId = "session";
  const key = createHash("sha256").update(sessionId).digest("hex");
  const path = join(stateDir, "context-cleaner", "openclaw-locks", `${key}.lock`);
  const candidateDir = `${path}.reclaimers`;
  await mkdir(candidateDir, { recursive: true });
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true });
  const pid = child.pid;
  assert.ok(pid);
  await once(child, "exit");
  await writeFile(path, JSON.stringify({ pid }));
  const old = new Date(Date.now() - 60_000);
  await utimes(path, old, old);
  const ownerId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const activeCandidate = join(candidateDir, `${process.pid}-${ownerId}.json`);
  await writeFile(activeCandidate, JSON.stringify({
    pid: process.pid, createdAt: new Date().toISOString(), ownerId,
  }));
  const future = new Date(Date.now() + 60_000);
  await utimes(activeCandidate, future, future);

  await assert.rejects(withOpenClawCleanerSessionLock({
    stateDir, sessionId, action: async () => assert.fail("active recovery owner displaced"),
  }), /session_busy/);
});
