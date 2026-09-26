import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  applySessionTaskRegistryPatch,
  createEmptySessionTaskRegistry,
  persistSessionTaskRegistry,
} from "@lightrsi/history";

import {
  createDshPersistedCleanerCapabilities,
} from "../src/context-cleaner/capabilities.js";
import {
  listDshCleanerSnapshots,
  persistDshCleanerSnapshot,
  readDshCleanerSnapshot,
} from "../src/context-cleaner/persisted-snapshot.js";
import { readDshCleanerSchedule } from "../src/context-cleaner/scheduler.js";
import { buildDshCleanSnapshot, surfaceRevision } from "../src/context-cleaner/snapshot.js";
import { createDshPersistedCleanerControlService } from "../src/product-registration.js";
import type { DshLogEventWithMeta, DshSession } from "../src/types.js";

const capturedAt = "2026-09-18T00:00:00.000Z";
const clock = () => Date.parse(capturedAt);

function makeSession(id = "persisted-cleaner-session"): DshSession {
  const events: DshLogEventWithMeta[] = [
    { seq: 1, type: "turn/start", data: { turn: 1 } },
    {
      seq: 2,
      type: "user/message",
      data: {
        id: "user-1",
        role: "user",
        content: [{ type: "text", text: "Make a short breakfast plan." }],
        source: { kind: "user" },
      },
    },
    {
      seq: 3,
      type: "assistant/message",
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "assistant-1",
          role: "assistant",
          content: [{ type: "text", text: "Completed plan: oats, milk, and fruit." }],
          source: { kind: "model" },
        },
      },
    },
  ];
  return {
    id,
    events,
    surface: { nodes: [2, 3], replaceGeneration: 0 },
    append: () => ({ seq: 4 }),
  };
}

function completedRegistry(session: DshSession) {
  return applySessionTaskRegistryPatch(createEmptySessionTaskRegistry(session.id), {
    upsertTasks: {
      "completed-plan": {
        taskId: "completed-plan",
        title: "Breakfast plan",
        objective: "Produce a short breakfast plan.",
        lifecycle: "completed",
        completionEvidence: ["The answer was delivered."],
        unresolvedQuestions: [],
        span: {
          firstTurnAbsId: `${session.id}:t1`,
          lastTurnAbsId: `${session.id}:t1`,
          supportingTurnAbsIds: [`${session.id}:t1`],
          lastEstimatorTurnAbsId: `${session.id}:t1`,
        },
      },
    },
    completedTaskIds: ["completed-plan"],
    evictableTaskIds: ["completed-plan"],
    upsertTurnToTaskIds: { [`${session.id}:t1`]: ["completed-plan"] },
  });
}

async function publish(stateDir: string, session: DshSession, snapshotCapturedAt = capturedAt) {
  const registry = completedRegistry(session);
  await persistSessionTaskRegistry(stateDir, registry, { expectedVersion: 0 });
  const { snapshot } = buildDshCleanSnapshot({
    session,
    registry,
    revision: surfaceRevision(session),
    capturedAt: snapshotCapturedAt,
  });
  await persistDshCleanerSnapshot({ stateDir, snapshot });
}

describe("DSH Context Cleaner persisted snapshots", () => {
  it("lets an external, restarted control service analyze and schedule without a live DSH object", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-dsh-persisted-"));
    try {
      const session = makeSession();
      await publish(stateDir, session);
      const beforeNodes = [...session.surface.nodes];

      const external = createDshPersistedCleanerControlService({
        stateDir,
        maxSnapshotAgeMs: 60_000,
        now: () => capturedAt,
        snapshotNow: clock,
      });
      const plan = await external.analyze(session.id);
      assert.equal(plan.sessionId, session.id);
      assert.deepEqual(plan.tasks.map((task) => task.taskId), ["completed-plan"]);
      assert.deepEqual(session.surface.nodes, beforeNodes, "external analysis cannot touch DSH's live surface");

      const receipt = await external.approve(plan.planId, ["completed-plan"]);
      assert.equal(receipt.status, "scheduled");
      assert.deepEqual(session.surface.nodes, beforeNodes, "external approval may write only the schedule pointer");
      const schedule = await readDshCleanerSchedule({ stateDir, sessionId: session.id });
      assert.equal(schedule.outcome, "ready");
      if (schedule.outcome === "ready") assert.equal(schedule.record.cleanPlanId, plan.planId);

      const stored = await readDshCleanerSnapshot({
        stateDir,
        sessionId: session.id,
        maxAgeMs: 60_000,
        now: clock,
      });
      assert.equal(stored.outcome, "ready");
      if (stored.outcome === "ready") {
        assert.equal(JSON.stringify(stored.snapshot).includes("oats, milk, and fruit"), false,
          "published snapshots are metadata-only and must not persist model-visible text");
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("reports a stale or absent trusted snapshot as unavailable instead of fabricating context", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-dsh-persisted-"));
    try {
      const session = makeSession("stale-persisted-session");
      await publish(stateDir, session, "2026-09-18T00:00:00.000Z");
      const afterExpiry = () => Date.parse("2026-09-18T00:02:00.000Z");
      const stale = await readDshCleanerSnapshot({
        stateDir,
        sessionId: session.id,
        maxAgeMs: 1_000,
        now: afterExpiry,
      });
      assert.equal(stale.outcome, "unavailable");
      if (stale.outcome === "unavailable") assert.deepEqual(stale.reasons, ["dsh_clean_snapshot_stale"]);

      const capabilities = createDshPersistedCleanerCapabilities({
        stateDir,
        maxSnapshotAgeMs: 1_000,
        now: afterExpiry,
      });
      await assert.rejects(
        capabilities.snapshotSource.readCleanSnapshot(session.id),
        /dsh_clean_snapshot_unavailable:dsh_clean_snapshot_stale/u,
      );
      await assert.rejects(
        capabilities.snapshotSource.readCleanSnapshot("unknown-session"),
        /dsh_clean_snapshot_unavailable:dsh_clean_snapshot_missing_or_invalid/u,
      );
      assert.deepEqual(await capabilities.sessionCatalog.listSessions(), []);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed item metadata at the trusted persistence boundary", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-dsh-persisted-"));
    try {
      const session = makeSession("malformed-item-session");
      const { snapshot } = buildDshCleanSnapshot({
        session,
        registry: completedRegistry(session),
        revision: surfaceRevision(session),
        capturedAt,
      });
      snapshot.items[0]!.taskIds = "task-a" as never;

      await assert.rejects(
        persistDshCleanerSnapshot({ stateDir, snapshot }),
        /dsh_clean_snapshot_write_invalid/u,
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("persists and returns only the declared metadata fields", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-dsh-persisted-"));
    try {
      const session = makeSession("sanitized-metadata-session");
      const { snapshot } = buildDshCleanSnapshot({
        session,
        registry: completedRegistry(session),
        revision: surfaceRevision(session),
        capturedAt,
      });
      const sentinel = "DO_NOT_PERSIST_UNKNOWN_DSH_PAYLOAD";
      (snapshot as unknown as Record<string, unknown>).adapterMetadata = { rawText: sentinel };
      (snapshot.items[0] as unknown as Record<string, unknown>).rawText = sentinel;

      await persistDshCleanerSnapshot({ stateDir, snapshot });
      const files = await readdir(join(stateDir, "cleaner-snapshot"));
      assert.equal(files.length, 1);
      const raw = await readFile(join(stateDir, "cleaner-snapshot", files[0]!), "utf8");
      assert.equal(raw.includes(sentinel), false, "unknown payload reached the persisted metadata boundary");

      const stored = await readDshCleanerSnapshot({
        stateDir,
        sessionId: session.id,
        maxAgeMs: 60_000,
        now: clock,
      });
      assert.equal(stored.outcome, "ready");
      assert.equal(JSON.stringify(stored).includes(sentinel), false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("refuses external approval after its trusted snapshot has expired", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-dsh-persisted-"));
    try {
      const session = makeSession("expired-approval-session");
      await publish(stateDir, session);
      const planning = createDshPersistedCleanerControlService({
        stateDir,
        maxSnapshotAgeMs: 60_000,
        now: () => capturedAt,
        snapshotNow: clock,
      });
      const plan = await planning.analyze(session.id);

      const expired = createDshPersistedCleanerControlService({
        stateDir,
        maxSnapshotAgeMs: 1_000,
        now: () => "2026-09-18T00:02:00.000Z",
        snapshotNow: () => Date.parse("2026-09-18T00:02:00.000Z"),
      });
      await assert.rejects(
        expired.approve(plan.planId, ["completed-plan"]),
        /clean_schedule_failed:dsh_clean_snapshot_stale/u,
      );
      assert.equal(
        (await readDshCleanerSchedule({ stateDir, sessionId: session.id })).outcome,
        "missing",
        "an expired external snapshot must not create a DSH schedule pointer",
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("refuses external approval when a fresh Host snapshot has a different revision", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-dsh-persisted-"));
    try {
      const session = makeSession("revision-approval-session");
      await publish(stateDir, session);
      const external = createDshPersistedCleanerControlService({
        stateDir,
        maxSnapshotAgeMs: 60_000,
        now: () => capturedAt,
        snapshotNow: clock,
      });
      const plan = await external.analyze(session.id);

      const changedSession = {
        ...session,
        surface: { ...session.surface, nodes: [2] },
      } as DshSession;
      const { snapshot } = buildDshCleanSnapshot({
        session: changedSession,
        registry: completedRegistry(changedSession),
        revision: surfaceRevision(changedSession),
        capturedAt,
      });
      await persistDshCleanerSnapshot({ stateDir, snapshot });

      await assert.rejects(
        external.approve(plan.planId, ["completed-plan"]),
        /clean_schedule_failed:dsh_clean_snapshot_revision_mismatch/u,
      );
      assert.equal(
        (await readDshCleanerSchedule({ stateDir, sessionId: session.id })).outcome,
        "missing",
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("lists only fresh snapshots, so a later external process cannot discover stale sessions", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-dsh-persisted-"));
    try {
      const fresh = makeSession("fresh-persisted-session");
      const stale = makeSession("older-persisted-session");
      await publish(stateDir, fresh, "2026-09-18T00:00:00.000Z");
      await publish(stateDir, stale, "2026-09-17T23:00:00.000Z");
      const sessions = await listDshCleanerSnapshots({
        stateDir,
        maxAgeMs: 60_000,
        now: clock,
      });
      assert.deepEqual(sessions.map((entry) => entry.sessionId), [fresh.id]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("fails closed when the persisted state directory cannot be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightrsi-dsh-persisted-"));
    const stateDir = join(root, "not-a-directory");
    try {
      // Use a regular file as stateDir: this is deterministic on every platform
      // and exercises the same unavailable-state path as a missing mount/ACL.
      await writeFile(stateDir, "not a directory\n", "utf8");
      const capabilities = createDshPersistedCleanerCapabilities({ stateDir });

      await assert.rejects(
        capabilities.snapshotSource.readCleanSnapshot("unavailable-session"),
        /dsh_clean_snapshot_unavailable:dsh_clean_snapshot_missing_or_invalid/u,
      );
      assert.deepEqual(await capabilities.sessionCatalog.listSessions(), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
