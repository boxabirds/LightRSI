import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  type ContextCleanPlan,
  type ContextCleanReceipt,
  type ExecuteApprovedContextCleanParams,
} from "@lightrsi/cleaner";
import {
  createEmptySessionTaskRegistry,
  loadCanonicalState,
  persistSessionTaskRegistry,
  saveCanonicalState,
} from "@lightrsi/history";
import { writeJsonFileAtomic } from "@lightrsi/host-adapter";

import { pluginStateSubdir } from "@lightrsi/artifact-store";
import { createOpenClawCleanerControlService } from "./service.js";
import { createOpenClawCleanerCapabilities } from "./capabilities.js";
import { applyScheduledOpenClawClean } from "./runtime.js";
import { createOpenClawCleanerSnapshotSource } from "./snapshot.js";
import { createOpenClawCleanerRewriteRequest } from "./snapshot.js";
import { createPluginContextEngine } from "../context-stack/integration/context-engine.js";
import { readOpenClawCleanerSchedule } from "./scheduler.js";

const SESSION_ID = "openclaw-clean-session";
const NOW = "2026-08-31T00:01:00.000Z";

function task(taskId: string, lifecycle: "active" | "evictable") {
  return {
    taskId,
    title: taskId,
    objective: `Objective for ${taskId}`,
    lifecycle,
    ...(lifecycle === "evictable" ? { evictableReason: "completed" } : {}),
    completionEvidence: lifecycle === "evictable" ? ["delivered"] : [],
    unresolvedQuestions: [],
    span: {
      firstTurnAbsId: `${taskId}-turn-1`,
      lastTurnAbsId: `${taskId}-turn-1`,
      supportingTurnAbsIds: [`${taskId}-turn-1`],
      lastEstimatorTurnAbsId: `${taskId}-turn-1`,
    },
  };
}

function message(messageId: string, taskId: string, content: string, role = "assistant") {
  return {
    messageId,
    role,
    content,
    details: {
      contextSafe: {
        taskIds: [taskId],
        turnAbsId: `${taskId}-turn-1`,
      },
    },
  };
}

async function seed(stateDir: string): Promise<void> {
  await saveCanonicalState(stateDir, {
    version: 1,
    sessionId: SESSION_ID,
    messages: [
      message("completed-user", "task-completed", "Investigate the completed issue", "user"),
      message("completed-answer", "task-completed", "The completed task delivered a detailed final result."),
      message("active-user", "task-active", "Continue the active task", "user"),
    ],
    seenMessageIds: ["completed-user", "completed-answer", "active-user"],
    updatedAt: "2026-08-31T00:00:00.000Z",
  });
  const registry = createEmptySessionTaskRegistry(SESSION_ID);
  registry.tasks = {
    "task-completed": task("task-completed", "evictable"),
    "task-active": task("task-active", "active"),
  };
  registry.completedTaskIds = ["task-completed"];
  registry.evictableTaskIds = ["task-completed"];
  registry.activeTaskIds = ["task-active"];
  await persistSessionTaskRegistry(stateDir, registry);
}

function approval(plan: ContextCleanPlan): ExecuteApprovedContextCleanParams {
  const selected = plan.tasks.find((entry) => entry.taskId === "task-completed");
  assert.ok(selected?.selectable);
  return {
    schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
    cleanPlanId: plan.planId,
    hostId: "openclaw",
    sessionId: plan.sessionId,
    baseRevision: plan.baseRevision,
    approvedAt: NOW,
    selectedTasks: [{
      taskId: selected.taskId,
      itemIds: [...selected.itemIds],
      itemDigests: { ...selected.itemDigests },
    }],
  };
}

async function analyzed(stateDir: string) {
  const capabilities = createOpenClawCleanerCapabilities({ stateDir, replacementMode: "drop" });
  const service = createOpenClawCleanerControlService({ stateDir, replacementMode: "drop", now: () => NOW });
  // Local aliases keep the existing scenario assertions focused on behavior.
  const bridge = {
    listSessions: capabilities.sessionCatalog.listSessions,
    readCleanSnapshot: capabilities.snapshotSource.readCleanSnapshot,
    executeApprovedClean: (request: ExecuteApprovedContextCleanParams) =>
      service.approve(request.cleanPlanId, request.selectedTasks.map((task) => task.taskId)),
    readCleanReceipt: service.readReceipt,
    cancelCleanPlan: service.cancel,
  };
  const plan = await service.analyze(SESSION_ID);
  return { bridge, service, plan };
}

const runScheduled = (stateDir: string) => applyScheduledOpenClawClean({
  stateDir, sessionId: SESSION_ID, replacementMode: "drop", now: () => NOW,
});

test("cancel and status do not mutate history; cancelled selection never executes", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-cancel-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await seed(stateDir);
  const { service, plan } = await analyzed(stateDir);
  const original = await loadCanonicalState(stateDir, SESSION_ID);
  await service.approve(plan.planId, ["task-completed"]);
  await service.readReceipt(plan.planId);
  const cancelled = await service.cancel(plan.planId);
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(await service.cancel(plan.planId), cancelled);
  assert.equal((await readOpenClawCleanerSchedule(stateDir, SESSION_ID))?.status, "terminal");
  await runScheduled(stateDir);
  assert.deepEqual(await loadCanonicalState(stateDir, SESSION_ID), original);
});

test("shared control service rejects invalid task selections without writing a schedule", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-selection-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await seed(stateDir);
  const { service, plan } = await analyzed(stateDir);
  for (const selection of [[], ["missing"], ["task-active"], ["task-completed", "task-completed"], [""]]) {
    await assert.rejects(service.approve(plan.planId, selection));
  }
  assert.equal(await readOpenClawCleanerSchedule(stateDir, SESSION_ID), undefined);
  assert.equal((await service.readReceipt(plan.planId))?.status, "analyzed");
});

test("a conflicting pointer keeps approval retryable and appended current context survives execution", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-retry-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await seed(stateDir);
  const { service, plan } = await analyzed(stateDir);
  await service.approve(plan.planId, ["task-completed"]);
  const state = await loadCanonicalState(stateDir, SESSION_ID);
  assert.ok(state);
  state.messages.push(message("new-active", "task-active", "A newer active turn", "user"));
  state.seenMessageIds.push("new-active");
  await saveCanonicalState(stateDir, state);
  const newer = await service.analyze(SESSION_ID);
  assert.notEqual(newer.planId, plan.planId);
  await assert.rejects(service.approve(newer.planId, ["task-completed"]), /schedule_conflict/);
  assert.equal((await service.readReceipt(newer.planId))?.status, "approved");
  assert.equal((await readOpenClawCleanerSchedule(stateDir, SESSION_ID))?.cleanPlanId, plan.planId);
  await service.cancel(plan.planId);
  assert.equal((await service.approve(newer.planId, ["task-completed"])).status, "scheduled");
  assert.equal((await runScheduled(stateDir)).receipt?.status, "applied");
  assert.deepEqual((await loadCanonicalState(stateDir, SESSION_ID))?.messages.map((entry) => entry.messageId),
    ["active-user", "new-active"]);
});

test("cancel racing execution produces one consistent outcome", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-race-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await seed(stateDir);
  const { service, plan } = await analyzed(stateDir);
  await service.approve(plan.planId, ["task-completed"]);
  const outcomes = await Promise.allSettled([runScheduled(stateDir), service.cancel(plan.planId)]);
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") assert.match(String(outcome.reason), /session_busy/);
  }
  const receipt = await service.readReceipt(plan.planId);
  assert.ok(receipt?.status === "applied" || receipt?.status === "cancelled");
  const state = await loadCanonicalState(stateDir, SESSION_ID);
  assert.equal(state?.messages.length, receipt.status === "applied" ? 1 : 3);
  await runScheduled(stateDir);
  assert.deepEqual(await loadCanonicalState(stateDir, SESSION_ID), state);
});

test("archive failure records failed without changing canonical context", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-failed-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await seed(stateDir);
  const { service, plan } = await analyzed(stateDir);
  const original = await loadCanonicalState(stateDir, SESSION_ID);
  await service.approve(plan.planId, ["task-completed"]);
  const archiveDir = pluginStateSubdir(stateDir, "canonical-eviction", "task");
  await mkdir(dirname(archiveDir), { recursive: true });
  await writeFile(archiveDir, "injected archive filesystem failure");
  assert.equal((await runScheduled(stateDir)).receipt?.status, "failed");
  assert.deepEqual(await loadCanonicalState(stateDir, SESSION_ID), original);
  assert.equal((await service.readReceipt(plan.planId))?.status, "failed");
  assert.equal((await runScheduled(stateDir)).reserved, false);
});

test("real Context Engine assemble consumes schedule and suppresses automatic eviction for that request", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-engine-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await seed(stateDir);
  const { service, plan } = await analyzed(stateDir);
  await service.approve(plan.planId, ["task-completed"]);
  const state = await loadCanonicalState(stateDir, SESSION_ID);
  assert.ok(state);
  const stages: string[] = [];
  const helpers = createOpenClawCleanerRewriteRequest({ stateDir, state, replacementMode: "drop" }).helpers;
  const engine = createPluginContextEngine({
    stateDir, moduleEnablement: { eviction: true },
    eviction: { enabled: true, policy: "model_scored", minBlockChars: 0, replacementMode: "drop" },
    memory: { enabled: false, autoDistill: false }, taskStateEstimator: { evidenceMode: "three_state" },
  }, { info() {}, warn() {} }, {
    ...helpers,
    readTranscriptEntriesForSession: async () => null,
    transcriptMessageStableId: (entry: { id: string }) => entry.id,
    appendTaskStateTrace: async (_dir: string, entry: { stage: string }) => { stages.push(entry.stage); },
    appendEvictionVisualSnapshot: async () => undefined,
  });
  await engine.afterTurn({ sessionId: SESSION_ID, messages: [] });
  assert.equal((await service.readReceipt(plan.planId))?.status, "scheduled");
  assert.deepEqual((await loadCanonicalState(stateDir, SESSION_ID))?.messages, state.messages);
  const assembled = await engine.assemble({ sessionId: SESSION_ID, messages: [] });
  assert.deepEqual(assembled.messages.map((entry) => entry.messageId), ["active-user"]);
  assert.equal((await service.readReceipt(plan.planId))?.status, "applied");
  await engine.afterTurn({ sessionId: SESSION_ID, messages: [] });
  assert.equal(stages.includes("history_eviction_completed"), false);
});

test("lists canonical sessions and exposes a chars-only cleaner snapshot", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-catalog-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  await seed(stateDir);
  const { bridge } = await analyzed(stateDir);

  assert.deepEqual(await bridge.listSessions(), [{
    sessionId: SESSION_ID,
    updatedAt: "2026-08-31T00:00:00.000Z",
  }]);
  const snapshot = await bridge.readCleanSnapshot(SESSION_ID);
  assert.equal(snapshot.hostId, "openclaw");
  assert.equal(snapshot.tokenCountMode, "chars_only");
  assert.equal(snapshot.tokenCountMethod, "utf16_chars");
  assert.equal(snapshot.items.length, 3);
});

test("standalone snapshot capability is read-only and excludes native adapter metadata", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-snapshot-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  await seed(stateDir);
  const before = await loadCanonicalState(stateDir, SESSION_ID);
  const source = createOpenClawCleanerSnapshotSource({ stateDir, replacementMode: "drop" });
  const snapshot = await source.readCleanSnapshot(SESSION_ID);
  assert.equal(source.hostId, "openclaw");
  assert.equal(source.rewriteMode, "canonical");
  assert.equal(snapshot.tokenCountMode, "chars_only");
  assert.equal(snapshot.capturedAt, before!.updatedAt);
  assert.equal(Object.hasOwn(snapshot, "adapterMetadata"), false);
  assert.deepEqual(await source.readCleanSnapshot(SESSION_ID), snapshot);
  assert.deepEqual(await loadCanonicalState(stateDir, SESSION_ID), before);
  await assert.rejects(source.readCleanSnapshot("missing-session"), /openclaw_clean_session_not_found/);
});

test("schedules without changing context, then applies once at the next request", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-apply-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  await seed(stateDir);
  const { bridge, plan } = await analyzed(stateDir);
  const request = approval(plan);

  const before = await loadCanonicalState(stateDir, SESSION_ID);
  const pending = await bridge.executeApprovedClean(request);
  assert.equal(pending.status, "scheduled");
  assert.deepEqual(await loadCanonicalState(stateDir, SESSION_ID), before);
  assert.equal((await bridge.readCleanReceipt(plan.planId))?.status, "scheduled");
  const { receipt } = await runScheduled(stateDir);
  assert.ok(receipt);

  assert.equal(receipt.status, "applied");
  if (receipt.status !== "applied") return;
  assert.equal(receipt.appliedSavedTokens, null);
  assert.ok(receipt.appliedSavedChars > 0);
  assert.equal(receipt.evidence.previousRevision, plan.baseRevision);
  assert.notEqual(receipt.evidence.nextRevision, plan.baseRevision);
  assert.deepEqual(receipt.selectedTaskIds, ["task-completed"]);
  assert.ok(receipt.evidence.itemIds.includes("completed-user"));

  const state = await loadCanonicalState(stateDir, SESSION_ID);
  assert.deepEqual(state?.messages.map((entry) => entry.messageId), ["active-user"]);
  const archiveDir = pluginStateSubdir(stateDir, "canonical-eviction", "task");
  assert.ok((await readdir(archiveDir)).some((name) => name.endsWith(".json")));
  assert.equal((await bridge.readCleanReceipt(plan.planId))?.status, "applied");

  const replayed = await bridge.executeApprovedClean(request);
  assert.deepEqual(replayed, receipt);
  assert.equal((await runScheduled(stateDir)).reserved, false);
  assert.deepEqual(await loadCanonicalState(stateDir, SESSION_ID), state);
});

test("marks a plan stale when canonical state changes after analysis", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-stale-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  await seed(stateDir);
  const { bridge, plan } = await analyzed(stateDir);
  const state = await loadCanonicalState(stateDir, SESSION_ID);
  assert.ok(state);
  state.messages[0].content = "The selected historical message was edited";

  state.updatedAt = "2026-08-31T00:02:00.000Z";
  await saveCanonicalState(stateDir, state);

  assert.equal((await bridge.executeApprovedClean(approval(plan))).status, "scheduled");
  const { receipt } = await runScheduled(stateDir);
  assert.ok(receipt);

  assert.equal(receipt.status, "stale");
  assert.ok(receipt.reasons.some((reason) => reason.includes("stale")));
  assert.equal((await loadCanonicalState(stateDir, SESSION_ID))?.messages.length, 3);
});

test("serializes competing cleaner applies before scheduling either mutation", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-lock-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  await seed(stateDir);
  const { bridge, plan } = await analyzed(stateDir);
  const key = createHash("sha256").update(SESSION_ID).digest("hex");
  const lockDir = join(stateDir, "context-cleaner", "openclaw-locks");
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, `${key}.lock`), JSON.stringify({ pid: process.pid }), "utf8");

  await assert.rejects(
    bridge.executeApprovedClean(approval(plan)),
    /openclaw_clean_session_busy/,
  );
  assert.equal((await bridge.readCleanReceipt(plan.planId))?.status, "analyzed");
});

test("recovers an applied receipt when canonical persistence completed before receipt commit", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-recovery-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  await seed(stateDir);
  const { bridge, plan } = await analyzed(stateDir);
  const request = approval(plan);
  const scheduled = await bridge.executeApprovedClean(request);
  assert.equal(scheduled.status, "scheduled");
  if (scheduled.status !== "scheduled") return;

  const before = await bridge.readCleanSnapshot(SESSION_ID);
  const nextState = await loadCanonicalState(stateDir, SESSION_ID);
  assert.ok(nextState);
  nextState.messages = nextState.messages.filter((entry) => entry.messageId === "active-user");
  nextState.updatedAt = "2026-08-31T00:03:00.000Z";
  await saveCanonicalState(stateDir, nextState);
  const after = await bridge.readCleanSnapshot(SESSION_ID);
  const applied: ContextCleanReceipt = {
    ...scheduled,
    status: "applied",
    appliedSavedTokens: null,
    appliedSavedChars: 80,
    fallbackUsed: false,
    evidence: {
      previousRevision: before.revision,
      nextRevision: after.revision,
      operationIds: ["recovered-operation"],
      itemIds: ["completed-user", "completed-answer"],
    },
  };
  const key = createHash("sha256").update(plan.planId).digest("hex");
  const intentFile = join(stateDir, "context-cleaner", "openclaw-apply", `${key}.json`);
  await writeJsonFileAtomic(intentFile, {
    version: 1,
    planId: plan.planId,
    sessionId: SESSION_ID,
    previousRevision: before.revision,
    nextRevision: after.revision,
    receipt: applied,
  });

  assert.equal((await bridge.readCleanReceipt(plan.planId))?.status, "scheduled");
  await assert.rejects(bridge.cancelCleanPlan(plan.planId), /recovery_required/);
  const { receipt: recovered } = await runScheduled(stateDir);

  assert.deepEqual(recovered, applied);
  await assert.rejects(readFile(intentFile, "utf8"), { code: "ENOENT" });
});
