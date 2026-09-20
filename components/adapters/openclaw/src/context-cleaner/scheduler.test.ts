import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  finishOpenClawCleanSchedule, openClawCleanerSchedulePath,
  readOpenClawCleanerSchedule, scheduleOpenClawClean,
} from "./scheduler.js";

const request = {
  sessionId: "session/../host", cleanPlanId: "plan-1", baseRevision: "revision-1",
  selectedTaskIds: ["task-a", "task-b"], scheduledAt: "2026-09-19T00:00:00.000Z",
};

test("schedule identity is immutable, private payloads are excluded, and terminal permits a new plan", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-schedule-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await readOpenClawCleanerSchedule(root, request.sessionId), undefined);
  const withExtra = { ...request, credential: "must-not-persist", transcript: ["private"] };
  assert.equal((await scheduleOpenClawClean(root, withExtra)).outcome, "stored");
  const path = openClawCleanerSchedulePath(root, request.sessionId);
  assert.match(basename(path), /^[a-f0-9]{64}\.json$/);
  const original = await readFile(path, "utf8");
  assert.doesNotMatch(original, /credential|transcript|must-not-persist/);
  assert.equal((await scheduleOpenClawClean(root, { ...request, selectedTaskIds: ["task-b", "task-a"] })).outcome, "unchanged");
  for (const changes of [
    { selectedTaskIds: ["task-a"] }, { baseRevision: "revision-2" },
    { cleanPlanId: "plan-2" }, { scheduledAt: "2026-09-19T00:01:00.000Z" },
  ]) {
    assert.equal((await scheduleOpenClawClean(root, { ...request, ...changes })).outcome, "conflict");
  }
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal((await finishOpenClawCleanSchedule(root, request, request.scheduledAt)).outcome, "transitioned");
  assert.equal((await finishOpenClawCleanSchedule(root, request, request.scheduledAt)).outcome, "unchanged");
  assert.equal((await scheduleOpenClawClean(root, request)).outcome, "unchanged");
  assert.equal((await readOpenClawCleanerSchedule(root, request.sessionId))?.status, "terminal");
  assert.equal((await scheduleOpenClawClean(root, { ...request, cleanPlanId: "plan-2" })).outcome, "stored");
});

test("corrupt schedule fails closed without overwriting it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-schedule-corrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await scheduleOpenClawClean(root, request);
  const path = openClawCleanerSchedulePath(root, request.sessionId);
  await writeFile(path, "{partial");
  await assert.rejects(readOpenClawCleanerSchedule(root, request.sessionId), /schedule_unreadable/);
  assert.equal((await scheduleOpenClawClean(root, request)).outcome, "bypassed");
  assert.equal(await readFile(path, "utf8"), "{partial");
});

test("concurrent schedules never overwrite an existing selection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-schedule-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const results = await Promise.all([
    scheduleOpenClawClean(root, request),
    scheduleOpenClawClean(root, { ...request, selectedTaskIds: ["task-c"] }),
  ]);
  assert.equal(results.filter((result) => result.outcome === "stored").length, 1);
  assert.ok(results.some((result) => result.outcome === "bypassed" || result.outcome === "conflict"));
  const record = await readOpenClawCleanerSchedule(root, request.sessionId);
  assert.ok(record);
  assert.equal((await scheduleOpenClawClean(root, record)).outcome, "unchanged");
});
