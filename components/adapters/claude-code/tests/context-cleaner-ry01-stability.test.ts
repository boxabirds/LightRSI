import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  createContextCleanerControlPlane,
  createContextCleanerControlService,
  readContextCleanReceipt,
  saveContextCleanPlan,
  transitionContextCleanState,
  type ContextCleanPlan,
  type ContextCleanPendingReceipt,
} from "@lightrsi/cleaner";
import type { RuntimeMessage } from "@lightrsi/kernel";

import { createClaudeCodeCleanerCapabilities } from "../src/context-cleaner/capabilities.js";
import {
  abandonClaudeCleanerOverlay,
  finalizeClaudeCleanerOverlay,
  prepareClaudeCleanerOverlay,
} from "../src/context-cleaner/runtime.js";
import {
  readClaudeCleanerSchedule,
  scheduleClaudeCleanerPlan,
} from "../src/context-cleaner/scheduler.js";
import { buildClaudeContextSnapshot } from "../src/context-rewrite/snapshot.js";

/**
 * RY-01: Cleaner stability across real Claude request paths.
 *
 * Every case builds the same A/B/C session in an isolated stateDir: A and B are
 * completed and evictable, C is still active and therefore protected. The suite
 * asserts that a selection only ever produces `scheduled`, that the next request
 * prepares an archive-first overlay whose forwarded payload drops exactly the
 * selected content, and that each failure path lands on the correct terminal
 * status without ever reporting space it did not actually release.
 */

const SESSION = "claude-ry01-session";
const PLAN = "claude-ry01-plan";
const REVISION = "claude-ry01-revision-1";
const NOW = "2026-09-26T00:00:00.000Z";

const EVICT_A = "EVICT_ME_A_completed_history_".repeat(8);
const EVICT_B = "EVICT_ME_B_completed_history_".repeat(8);
const KEEP_C = "KEEP_ME_C_active_history_".repeat(8);
const CURRENT = "CURRENT_REQUEST_keep_this_turn";

type Seeded = {
  messages: RuntimeMessage[];
  snapshot: ReturnType<typeof buildClaudeContextSnapshot>;
  plan: ContextCleanPlan;
  itemIdFor(taskId: string): string;
};

async function withTempState(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-claude-ry01-"));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

/** Builds the A/B/C session and its plan without writing anything yet. */
function buildSession(revision = REVISION): Seeded {
  const messages: RuntimeMessage[] = [
    { role: "assistant", content: EVICT_A },
    { role: "assistant", content: EVICT_B },
    { role: "assistant", content: KEEP_C },
    { role: "user", content: CURRENT },
  ];
  const raw = buildClaudeContextSnapshot({ sessionId: SESSION, revision, messages });
  const taskByIndex = ["task-a", "task-b", "task-c"];
  const snapshot = {
    ...raw,
    items: raw.items.map((item, index) => {
      const taskId = taskByIndex[index];
      return taskId ? { ...item, taskIds: [taskId] } : item;
    }),
  };
  const itemFor = (taskId: string) =>
    snapshot.items.find((item) => item.taskIds?.includes(taskId))!;

  const task = (taskId: string, selectable: boolean) => {
    const item = itemFor(taskId);
    return {
      taskId,
      label: taskId,
      description: `${taskId} history`,
      summary: taskId,
      lifecycleState: selectable ? ("completed" as const) : ("active" as const),
      itemIds: [item.stableId],
      itemDigests: { [item.stableId]: item.fingerprint },
      tokenCount: null,
      charCount: item.chars,
      tokenPercent: null,
      recommendation: selectable ? ("clean" as const) : ("keep" as const),
      reasonCodes: selectable ? ["completed"] : ["active"],
      selectable,
    };
  };

  const unassignedChars = snapshot.items
    .filter((item) => item.taskIds === undefined)
    .reduce((total, item) => total + item.chars, 0);

  const plan: ContextCleanPlan = {
    schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
    planId: PLAN,
    hostId: "claude-code",
    sessionId: SESSION,
    baseRevision: revision,
    usedTokens: null,
    usedChars: snapshot.items.reduce((total, item) => total + item.chars, 0),
    protectedTokens: null,
    protectedChars: itemFor("task-c").chars,
    unassignedTokens: null,
    unassignedChars,
    tokenCountMode: "chars_only",
    tokenCountMethod: "utf16_chars",
    createdAt: NOW,
    tasks: [task("task-a", true), task("task-b", true), task("task-c", false)],
  };

  return { messages, snapshot, plan, itemIdFor: (taskId) => itemFor(taskId).stableId };
}

function pendingReceipt(selectedTaskIds: string[], savedChars: number): Omit<ContextCleanPendingReceipt, "status"> {
  return {
    schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
    planId: PLAN,
    hostId: "claude-code",
    sessionId: SESSION,
    selectedTaskIds,
    estimatedSavedTokens: null,
    estimatedSavedChars: savedChars,
    tokenCountMode: "chars_only",
    deferredTaskIds: [],
    fallbackUsed: false,
    reasons: [],
    updatedAt: NOW,
  };
}

/** Drives the plan to `scheduled` the way an explicit user selection would. */
async function scheduleSelection(
  stateDir: string,
  seeded: Seeded,
  selectedTaskIds: string[],
): Promise<void> {
  assert.equal((await saveContextCleanPlan({ stateDir, plan: seeded.plan })).outcome, "stored");
  const savedChars = seeded.plan.tasks
    .filter((task) => selectedTaskIds.includes(task.taskId))
    .reduce((total, task) => total + task.charCount, 0);
  const receipt = pendingReceipt(selectedTaskIds, savedChars);
  await transitionContextCleanState({ stateDir, receipt: { ...receipt, status: "approved" } });
  await transitionContextCleanState({ stateDir, receipt: { ...receipt, status: "scheduled" } });
  assert.equal((await scheduleClaudeCleanerPlan({
    stateDir,
    sessionId: SESSION,
    cleanPlanId: PLAN,
    baseRevision: seeded.plan.baseRevision,
    selectedTaskIds,
    scheduledAt: NOW,
  })).outcome, "stored");
}

function overlayText(request: { messages: readonly RuntimeMessage[] }): string {
  return JSON.stringify(request.messages);
}

// --- Step 1: the plan exposes A/B/C, C is protected, nothing is preselected ---

test("RY-01 plan lists A, B and C with C protected and no task preselected", async () => {
  await withTempState(async (stateDir) => {
    const seeded = buildSession();
    assert.equal((await saveContextCleanPlan({ stateDir, plan: seeded.plan })).outcome, "stored");

    assert.deepEqual(seeded.plan.tasks.map((task) => task.taskId), ["task-a", "task-b", "task-c"]);
    assert.deepEqual(seeded.plan.tasks.map((task) => task.selectable), [true, true, false]);
    assert.equal(seeded.plan.protectedChars > 0, true);

    // Nothing is selected until a user selects it: no receipt exists yet.
    const receipt = await readContextCleanReceipt({ stateDir, planId: PLAN });
    assert.equal(receipt.value, undefined);

    // And no Host schedule pointer has been written.
    assert.equal((await readClaudeCleanerSchedule({ stateDir, sessionId: SESSION })).outcome, "missing");
  });
});

test("RY-01 the shared control service refuses to approve the protected active task", async () => {
  await withTempState(async (stateDir) => {
    const seeded = buildSession();
    assert.equal((await saveContextCleanPlan({ stateDir, plan: seeded.plan })).outcome, "stored");

    const service = createContextCleanerControlService({
      stateDir,
      capabilities: createClaudeCodeCleanerCapabilities({ stateDir }),
      controlPlane: createContextCleanerControlPlane({ stateDir, now: () => NOW }),
      now: () => NOW,
    });

    await assert.rejects(service.approve(PLAN, ["task-c"]), /clean_selection_task_protected/);
    await assert.rejects(service.approve(PLAN, ["task-a", "task-a"]), /clean_selection_duplicate_task/);
    await assert.rejects(service.approve(PLAN, ["task-unknown"]), /clean_selection_unknown_task/);

    // A refused selection must not leave a schedule pointer behind.
    assert.equal((await readClaudeCleanerSchedule({ stateDir, sessionId: SESSION })).outcome, "missing");
  });
});

// --- Step 2: selection only schedules; the next request builds the overlay ---

test("RY-01 selecting A only schedules and mutates nothing before the next request", async () => {
  await withTempState(async (stateDir) => {
    const seeded = buildSession();
    await scheduleSelection(stateDir, seeded, ["task-a"]);

    const receipt = await readContextCleanReceipt({ stateDir, planId: PLAN });
    assert.equal(receipt.value?.status, "scheduled");
    assert.equal("appliedSavedChars" in (receipt.value ?? {}), false);

    const schedule = await readClaudeCleanerSchedule({ stateDir, sessionId: SESSION });
    assert.equal(schedule.outcome, "ready");
    if (schedule.outcome === "ready") {
      assert.deepEqual(schedule.record.selectedTaskIds, ["task-a"]);
    }
  });
});

test("RY-01 the forwarded request drops only the selected task and keeps the rest", async () => {
  await withTempState(async (stateDir) => {
    const seeded = buildSession();
    await scheduleSelection(stateDir, seeded, ["task-a"]);

    const prepared = await prepareClaudeCleanerOverlay({
      stateDir,
      sessionId: SESSION,
      baseSnapshot: seeded.snapshot,
      currentSnapshot: seeded.snapshot,
      request: { sessionId: SESSION, revision: REVISION, messages: seeded.messages },
      activeTaskIds: ["task-c"],
      evictableTaskIds: ["task-a", "task-b"],
      now: NOW,
    });

    assert.equal(prepared.outcome, "prepared", JSON.stringify(prepared));
    if (prepared.outcome !== "prepared") return;
    assert.equal(prepared.suppressAutomaticEviction, true);

    const forwarded = overlayText(prepared.request);
    assert.equal(forwarded.includes("EVICT_ME_A"), false, "selected task A must be gone");
    assert.equal(forwarded.includes("EVICT_ME_B"), true, "unselected task B must survive");
    assert.equal(forwarded.includes("KEEP_ME_C"), true, "protected task C must survive");
    assert.equal(forwarded.includes("CURRENT_REQUEST"), true, "the current turn must survive");
    assert.equal(prepared.request.messages.length, seeded.messages.length);
    assert.deepEqual(prepared.rewriteResult.removedItemIds, [seeded.itemIdFor("task-a")]);
  });
});

test("RY-01 selecting A and B drops both while the protected task and current turn stay", async () => {
  await withTempState(async (stateDir) => {
    const seeded = buildSession();
    await scheduleSelection(stateDir, seeded, ["task-a", "task-b"]);

    const prepared = await prepareClaudeCleanerOverlay({
      stateDir,
      sessionId: SESSION,
      baseSnapshot: seeded.snapshot,
      currentSnapshot: seeded.snapshot,
      request: { sessionId: SESSION, revision: REVISION, messages: seeded.messages },
      activeTaskIds: ["task-c"],
      evictableTaskIds: ["task-a", "task-b"],
      now: NOW,
    });

    assert.equal(prepared.outcome, "prepared", JSON.stringify(prepared));
    if (prepared.outcome !== "prepared") return;
    const forwarded = overlayText(prepared.request);
    assert.equal(forwarded.includes("EVICT_ME_A"), false);
    assert.equal(forwarded.includes("EVICT_ME_B"), false);
    assert.equal(forwarded.includes("KEEP_ME_C"), true);
    assert.equal(forwarded.includes("CURRENT_REQUEST"), true);
    assert.deepEqual(
      [...prepared.rewriteResult.removedItemIds].sort(),
      [seeded.itemIdFor("task-a"), seeded.itemIdFor("task-b")].sort(),
    );
  });
});

// --- Step 3: every failure path lands on an accurate terminal status ---

test("RY-01 an abandoned overlay keeps the plan scheduled and reports no release", async () => {
  await withTempState(async (stateDir) => {
    const seeded = buildSession();
    await scheduleSelection(stateDir, seeded, ["task-a"]);

    const prepared = await prepareClaudeCleanerOverlay({
      stateDir,
      sessionId: SESSION,
      baseSnapshot: seeded.snapshot,
      currentSnapshot: seeded.snapshot,
      request: { sessionId: SESSION, revision: REVISION, messages: seeded.messages },
      activeTaskIds: ["task-c"],
      evictableTaskIds: ["task-a", "task-b"],
      now: NOW,
    });
    assert.equal(prepared.outcome, "prepared");
    if (prepared.outcome !== "prepared") return;

    // Upstream rejected the request, or it was interrupted before it was sent.
    await abandonClaudeCleanerOverlay(prepared);

    const receipt = await readContextCleanReceipt({ stateDir, planId: PLAN });
    assert.equal(receipt.value?.status, "scheduled", "an unsent overlay must not become applied");
    assert.equal("appliedSavedChars" in (receipt.value ?? {}), false, "nothing was released");
    assert.equal((await readClaudeCleanerSchedule({ stateDir, sessionId: SESSION })).outcome, "ready");
  });
});

test("RY-01 a retry after an abandoned overlay still prepares and can then commit", async () => {
  await withTempState(async (stateDir) => {
    const seeded = buildSession();
    await scheduleSelection(stateDir, seeded, ["task-a"]);

    const first = await prepareClaudeCleanerOverlay({
      stateDir,
      sessionId: SESSION,
      baseSnapshot: seeded.snapshot,
      currentSnapshot: seeded.snapshot,
      request: { sessionId: SESSION, revision: REVISION, messages: seeded.messages },
      activeTaskIds: ["task-c"],
      evictableTaskIds: ["task-a", "task-b"],
      now: NOW,
    });
    assert.equal(first.outcome, "prepared");
    if (first.outcome !== "prepared") return;
    await abandonClaudeCleanerOverlay(first);

    const second = await prepareClaudeCleanerOverlay({
      stateDir,
      sessionId: SESSION,
      baseSnapshot: seeded.snapshot,
      currentSnapshot: seeded.snapshot,
      request: { sessionId: SESSION, revision: REVISION, messages: seeded.messages },
      activeTaskIds: ["task-c"],
      evictableTaskIds: ["task-a", "task-b"],
      now: "2026-09-26T00:00:05.000Z",
    });
    assert.equal(second.outcome, "prepared", JSON.stringify(second));
    if (second.outcome !== "prepared") return;

    const finalized = await finalizeClaudeCleanerOverlay({
      stateDir,
      prepared: second,
      now: "2026-09-26T00:00:06.000Z",
    });
    assert.equal(finalized.outcome, "applied");
    const receipt = await readContextCleanReceipt({ stateDir, planId: PLAN });
    assert.equal(receipt.value?.status, "applied");
    assert.equal(receipt.value?.appliedSavedChars, second.rewriteResult.savedChars);
  });
});

test("RY-01 a drifted revision with rewritten history lands on stale, not applied", async () => {
  await withTempState(async (stateDir) => {
    const seeded = buildSession();
    await scheduleSelection(stateDir, seeded, ["task-a"]);

    // The user edited history: same session, new revision, different content.
    const drifted = buildClaudeContextSnapshot({
      sessionId: SESSION,
      revision: "claude-ry01-revision-2",
      messages: [
        { role: "assistant", content: "REWRITTEN_A_no_longer_matches" },
        { role: "assistant", content: EVICT_B },
        { role: "assistant", content: KEEP_C },
        { role: "user", content: CURRENT },
      ],
    });

    const result = await prepareClaudeCleanerOverlay({
      stateDir,
      sessionId: SESSION,
      baseSnapshot: drifted,
      currentSnapshot: drifted,
      request: {
        sessionId: SESSION,
        revision: "claude-ry01-revision-2",
        messages: [
          { role: "assistant", content: "REWRITTEN_A_no_longer_matches" },
          { role: "assistant", content: EVICT_B },
          { role: "assistant", content: KEEP_C },
          { role: "user", content: CURRENT },
        ],
      },
      activeTaskIds: ["task-c"],
      evictableTaskIds: ["task-a", "task-b"],
      now: NOW,
    });

    assert.notEqual(result.outcome, "prepared", JSON.stringify(result));
    assert.equal(result.suppressAutomaticEviction, true);
    const receipt = await readContextCleanReceipt({ stateDir, planId: PLAN });
    assert.notEqual(receipt.value?.status, "applied");
    assert.equal("appliedSavedChars" in (receipt.value ?? {}), false);
  });
});

test("RY-01 a target that is no longer evictable lands on stale without rewriting", async () => {
  await withTempState(async (stateDir) => {
    const seeded = buildSession();
    await scheduleSelection(stateDir, seeded, ["task-a"]);

    // Task A became active again between scheduling and the next request.
    const result = await prepareClaudeCleanerOverlay({
      stateDir,
      sessionId: SESSION,
      baseSnapshot: seeded.snapshot,
      currentSnapshot: seeded.snapshot,
      request: { sessionId: SESSION, revision: REVISION, messages: seeded.messages },
      activeTaskIds: ["task-a", "task-c"],
      evictableTaskIds: ["task-b"],
      now: NOW,
    });

    assert.notEqual(result.outcome, "prepared", JSON.stringify(result));
    const receipt = await readContextCleanReceipt({ stateDir, planId: PLAN });
    assert.notEqual(receipt.value?.status, "applied");
  });
});

test("RY-01 an archive write failure lands on a terminal status and never reports applied", async () => {
  await withTempState(async (stateDir) => {
    // Only tool_result content is archived before it is stubbed, so this case
    // needs a tool pair as the selected target rather than plain text.
    const messages: RuntimeMessage[] = [
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "toolu_ry01_archive",
          name: "Read",
          input: { path: "/repo/old.txt" },
        }],
      } as unknown as RuntimeMessage,
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_ry01_archive",
          content: "EVICT_TOOL_RESULT_A_".repeat(80),
        }],
      } as unknown as RuntimeMessage,
      { role: "assistant", content: KEEP_C },
      { role: "user", content: CURRENT },
    ];
    const raw = buildClaudeContextSnapshot({ sessionId: SESSION, revision: REVISION, messages });
    assert.equal(raw.items.length, 4);
    const snapshot = {
      ...raw,
      items: raw.items.map((item, index) => {
        if (index === 0 || index === 1) return { ...item, taskIds: ["task-a"] };
        if (index === 2) return { ...item, taskIds: ["task-c"] };
        return item;
      }),
    };
    const targets = snapshot.items.filter((item) => item.taskIds?.includes("task-a"));
    assert.deepEqual(targets.map((item) => item.kind), ["tool_call", "tool_result"]);

    const plan: ContextCleanPlan = {
      ...buildSession().plan,
      baseRevision: REVISION,
      usedChars: snapshot.items.reduce((total, item) => total + item.chars, 0),
      protectedChars: snapshot.items[2]!.chars,
      unassignedChars: snapshot.items[3]!.chars,
      tasks: [{
        taskId: "task-a",
        label: "task-a",
        description: "task-a tool pair",
        summary: "task-a",
        lifecycleState: "completed",
        itemIds: targets.map((item) => item.stableId),
        itemDigests: Object.fromEntries(targets.map((item) => [item.stableId, item.fingerprint])),
        tokenCount: null,
        charCount: targets.reduce((total, item) => total + item.chars, 0),
        tokenPercent: null,
        recommendation: "clean",
        reasonCodes: ["completed"],
        selectable: true,
      }],
    };
    assert.equal((await saveContextCleanPlan({ stateDir, plan })).outcome, "stored");
    const receipt = pendingReceipt(["task-a"], plan.tasks[0]!.charCount);
    await transitionContextCleanState({ stateDir, receipt: { ...receipt, status: "approved" } });
    await transitionContextCleanState({ stateDir, receipt: { ...receipt, status: "scheduled" } });
    await scheduleClaudeCleanerPlan({
      stateDir,
      sessionId: SESSION,
      cleanPlanId: PLAN,
      baseRevision: REVISION,
      selectedTaskIds: ["task-a"],
      scheduledAt: NOW,
    });

    // Occupy the archive directory path with a regular file so the real archive
    // write throws for reasons unrelated to process privileges.
    const archiveDir = join(stateDir, "claude-context", "archive");
    await mkdir(dirname(archiveDir), { recursive: true });
    await writeFile(archiveDir, "not a directory", "utf8");

    const result = await prepareClaudeCleanerOverlay({
      stateDir,
      sessionId: SESSION,
      baseSnapshot: snapshot,
      currentSnapshot: snapshot,
      request: { sessionId: SESSION, revision: REVISION, messages },
      activeTaskIds: ["task-c"],
      evictableTaskIds: ["task-a"],
      now: NOW,
    });

    assert.notEqual(result.outcome, "prepared", JSON.stringify(result));
    assert.equal(result.suppressAutomaticEviction, true);
    const stored = await readContextCleanReceipt({ stateDir, planId: PLAN });
    assert.notEqual(stored.value?.status, "applied");
    assert.equal("appliedSavedChars" in (stored.value ?? {}), false);
    assert.equal(
      stored.value?.reasons.includes("claude_cleaner_archive_incomplete"),
      true,
      `expected an archive-incomplete reason, got ${JSON.stringify(stored.value?.reasons)}`,
    );
  });
});

test("RY-01 a receipt write that loses the race reserves instead of claiming applied", async () => {
  await withTempState(async (stateDir) => {
    const seeded = buildSession();
    await scheduleSelection(stateDir, seeded, ["task-a"]);

    const prepared = await prepareClaudeCleanerOverlay({
      stateDir,
      sessionId: SESSION,
      baseSnapshot: seeded.snapshot,
      currentSnapshot: seeded.snapshot,
      request: { sessionId: SESSION, revision: REVISION, messages: seeded.messages },
      activeTaskIds: ["task-c"],
      evictableTaskIds: ["task-a", "task-b"],
      now: NOW,
    });
    assert.equal(prepared.outcome, "prepared");
    if (prepared.outcome !== "prepared") return;

    // A concurrent cancel reached the shared store first.
    const savedChars = seeded.plan.tasks.find((task) => task.taskId === "task-a")!.charCount;
    await transitionContextCleanState({
      stateDir,
      receipt: {
        ...pendingReceipt(["task-a"], savedChars),
        status: "cancelled",
        deferredTaskIds: ["task-a"],
        reasons: ["user_cancelled"],
        updatedAt: "2026-09-26T00:00:03.000Z",
      },
    });

    const finalized = await finalizeClaudeCleanerOverlay({
      stateDir,
      prepared,
      now: "2026-09-26T00:00:04.000Z",
    });

    assert.equal(finalized.outcome, "reserved", JSON.stringify(finalized));
    const receipt = await readContextCleanReceipt({ stateDir, planId: PLAN });
    assert.equal(receipt.value?.status, "cancelled");
    assert.equal("appliedSavedChars" in (receipt.value ?? {}), false);
  });
});

test("RY-01 a plan cancelled before the next request is never prepared", async () => {
  await withTempState(async (stateDir) => {
    const seeded = buildSession();
    await scheduleSelection(stateDir, seeded, ["task-a"]);

    const savedChars = seeded.plan.tasks.find((task) => task.taskId === "task-a")!.charCount;
    await transitionContextCleanState({
      stateDir,
      receipt: {
        ...pendingReceipt(["task-a"], savedChars),
        status: "cancelled",
        deferredTaskIds: ["task-a"],
        reasons: ["user_cancelled"],
        updatedAt: "2026-09-26T00:00:03.000Z",
      },
    });

    const result = await prepareClaudeCleanerOverlay({
      stateDir,
      sessionId: SESSION,
      baseSnapshot: seeded.snapshot,
      currentSnapshot: seeded.snapshot,
      request: { sessionId: SESSION, revision: REVISION, messages: seeded.messages },
      activeTaskIds: ["task-c"],
      evictableTaskIds: ["task-a", "task-b"],
      now: NOW,
    });

    assert.equal(result.outcome, "terminal", JSON.stringify(result));
    assert.equal(result.suppressAutomaticEviction, true);
    const receipt = await readContextCleanReceipt({ stateDir, planId: PLAN });
    assert.equal(receipt.value?.status, "cancelled");
  });
});

// --- Step 4: execution rights are exclusive and terminal state only replays ---

test("RY-01 a duplicate request after apply replays the receipt without a second overlay", async () => {
  await withTempState(async (stateDir) => {
    const seeded = buildSession();
    await scheduleSelection(stateDir, seeded, ["task-a"]);

    const prepared = await prepareClaudeCleanerOverlay({
      stateDir,
      sessionId: SESSION,
      baseSnapshot: seeded.snapshot,
      currentSnapshot: seeded.snapshot,
      request: { sessionId: SESSION, revision: REVISION, messages: seeded.messages },
      activeTaskIds: ["task-c"],
      evictableTaskIds: ["task-a", "task-b"],
      now: NOW,
    });
    assert.equal(prepared.outcome, "prepared");
    if (prepared.outcome !== "prepared") return;
    assert.equal((await finalizeClaudeCleanerOverlay({
      stateDir,
      prepared,
      now: "2026-09-26T00:00:02.000Z",
    })).outcome, "applied");

    const applied = await readContextCleanReceipt({ stateDir, planId: PLAN });
    assert.equal(applied.value?.status, "applied");
    const appliedChars = applied.value?.appliedSavedChars;

    // The same request arrives again, e.g. after a retry or a process restart.
    const replay = await prepareClaudeCleanerOverlay({
      stateDir,
      sessionId: SESSION,
      baseSnapshot: seeded.snapshot,
      currentSnapshot: seeded.snapshot,
      request: { sessionId: SESSION, revision: REVISION, messages: seeded.messages },
      activeTaskIds: ["task-c"],
      evictableTaskIds: ["task-a", "task-b"],
      now: "2026-09-26T00:00:07.000Z",
    });

    assert.equal(replay.outcome, "terminal", JSON.stringify(replay));
    assert.equal(replay.suppressAutomaticEviction, true);
    const after = await readContextCleanReceipt({ stateDir, planId: PLAN });
    assert.equal(after.value?.status, "applied");
    assert.equal(after.value?.appliedSavedChars, appliedChars, "a replay must not re-count savings");
  });
});

test("RY-01 a session with no schedule stays absent and leaves automatic eviction alone", async () => {
  await withTempState(async (stateDir) => {
    const seeded = buildSession();

    const result = await prepareClaudeCleanerOverlay({
      stateDir,
      sessionId: SESSION,
      baseSnapshot: seeded.snapshot,
      currentSnapshot: seeded.snapshot,
      request: { sessionId: SESSION, revision: REVISION, messages: seeded.messages },
      activeTaskIds: ["task-c"],
      evictableTaskIds: ["task-a", "task-b"],
      now: NOW,
    });

    assert.deepEqual(result, { outcome: "absent", suppressAutomaticEviction: false, reasonCodes: [] });
  });
});

test("RY-01 the schedule pointer survives a restart and the plan is still executable", async () => {
  await withTempState(async (stateDir) => {
    const seeded = buildSession();
    await scheduleSelection(stateDir, seeded, ["task-b"]);

    // Simulate a crash before the overlay was prepared: nothing in memory is
    // carried over, the next call reads the persisted pointer from scratch.
    const schedule = await readClaudeCleanerSchedule({ stateDir, sessionId: SESSION });
    assert.equal(schedule.outcome, "ready");
    if (schedule.outcome === "ready") {
      assert.equal(schedule.record.cleanPlanId, PLAN);
      assert.deepEqual(schedule.record.selectedTaskIds, ["task-b"]);
      assert.equal(schedule.record.baseRevision, REVISION);
    }

    const prepared = await prepareClaudeCleanerOverlay({
      stateDir,
      sessionId: SESSION,
      baseSnapshot: seeded.snapshot,
      currentSnapshot: seeded.snapshot,
      request: { sessionId: SESSION, revision: REVISION, messages: seeded.messages },
      activeTaskIds: ["task-c"],
      evictableTaskIds: ["task-a", "task-b"],
      now: NOW,
    });
    assert.equal(prepared.outcome, "prepared", JSON.stringify(prepared));
    if (prepared.outcome !== "prepared") return;

    const forwarded = overlayText(prepared.request);
    assert.equal(forwarded.includes("EVICT_ME_B"), false);
    assert.equal(forwarded.includes("EVICT_ME_A"), true, "an unselected task survives a restart too");
  });
});
