import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs, { mkdir, mkdtemp, readdir, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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

test("publishes complete recovery records even when writes are partial", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-atomic-candidate-"));
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

  const realWriteFile = fs.writeFile;
  const realReadFile = fs.readFile;
  const phases: boolean[] = [];
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    const [target, data] = args;
    if (typeof target === "string" && dirname(target) === `${path}.reclaimers`) {
      const record = JSON.parse(String(data));
      await realWriteFile(target, "{");
      const published = join(dirname(target), `${record.pid}-${record.ownerId}.json`);
      if (record.choosing) {
        await assert.rejects(realReadFile(published, "utf8"), { code: "ENOENT" });
      } else {
        assert.equal(JSON.parse(await realReadFile(published, "utf8")).choosing, true);
      }
      phases.push(record.choosing);
      // The partial write already created the temporary file; finish that
      // same write without attempting another exclusive creation.
      return realWriteFile(target, data);
    }
    return realWriteFile(...args);
  });
  syncBuiltinESMExports();

  assert.equal(await withOpenClawCleanerSessionLock({
    stateDir, sessionId, action: async () => "recovered",
  }), "recovered");
  assert.deepEqual(phases, [true, false]);
});

test("recovers when a competing candidate disappears between stat and read", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-disappearing-candidate-"));
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
  const candidatePath = join(candidateDir, `${process.pid}-${ownerId}.json`);
  await writeFile(candidatePath, JSON.stringify({
    pid: process.pid, ownerId, createdAt: new Date().toISOString(), choosing: false, ticket: 1000,
  }));

  const realReadFile = fs.readFile;
  let removed = false;
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    if (args[0] === candidatePath && !removed) {
      removed = true;
      await unlink(candidatePath);
    }
    return realReadFile(...args);
  });
  syncBuiltinESMExports();

  assert.equal(await withOpenClawCleanerSessionLock({
    stateDir, sessionId, action: async () => "recovered",
  }), "recovered");
  assert.equal(removed, true);
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
