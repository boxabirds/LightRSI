import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  sessionSnapshotPath,
} from "@lightrsi/host-adapter";

import { createClaudeCodeCleanerCapabilities } from "../src/context-cleaner/capabilities.js";
import { saveLatestClaudeSnapshot } from "../src/context-rewrite/snapshot-store.js";
import { upsertClaudeCodeSessionSnapshot } from "../src/session-state.js";

async function seedSession(stateDir: string, sessionId: string): Promise<void> {
  await upsertClaudeCodeSessionSnapshot(stateDir, sessionId, {
    latestModel: "claude-sonnet-4-6",
  });
  await saveLatestClaudeSnapshot(
    stateDir,
    sessionId,
    {
      schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
      hostId: "claude-code",
      sessionId,
      revision: "revision-1",
      items: [{ stableId: "item-1", kind: "user", fingerprint: "digest-1", chars: 12 }],
    },
    { model: "claude-sonnet-4-6" },
  );
}

test("createClaudeCodeCleanerCapabilities exposes the frozen host id and mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-claude-caps-"));
  try {
    const capabilities = createClaudeCodeCleanerCapabilities({ stateDir: join(root, "state") });
    assert.equal(capabilities.hostId, "claude-code");
    assert.equal(capabilities.rewriteMode, "request_overlay");
    assert.equal(capabilities.snapshotSource.hostId, "claude-code");
    assert.equal(capabilities.snapshotSource.rewriteMode, "request_overlay");
    assert.equal(typeof capabilities.snapshotSource.readCleanSnapshot, "function");
    assert.equal(typeof capabilities.sessionCatalog.listSessions, "function");
    assert.equal(typeof capabilities.scheduleWriter.writeSchedule, "function");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot source reads a seeded snapshot and rejects a session without one", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-claude-caps-snap-"));
  try {
    const stateDir = join(root, "state");
    await seedSession(stateDir, "session-a");
    const capabilities = createClaudeCodeCleanerCapabilities({ stateDir });

    const snapshot = await capabilities.snapshotSource.readCleanSnapshot("session-a");
    assert.equal(snapshot.hostId, "claude-code");
    assert.equal(snapshot.sessionId, "session-a");
    assert.equal(snapshot.revision, "revision-1");
    assert.equal(snapshot.model, "claude-sonnet-4-6");
    assert.equal(snapshot.tokenCountMode, "chars_only");
    assert.equal(snapshot.tokenCountMethod, "utf16_chars");
    assert.equal(snapshot.itemTokenCounts, undefined);
    assert.ok(snapshot.capturedAt);
    assert.equal("adapterMetadata" in snapshot, false);
    assert.equal("messages" in snapshot, false);

    // Reading twice must not re-derive or mutate the canonical snapshot.
    const repeated = await capabilities.snapshotSource.readCleanSnapshot("session-a");
    assert.equal(repeated.revision, snapshot.revision);
    assert.deepEqual(repeated.items, snapshot.items);
    assert.equal(repeated.capturedAt, snapshot.capturedAt);

    await assert.rejects(
      capabilities.snapshotSource.readCleanSnapshot("session-missing"),
      /claude_clean_snapshot_unavailable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session catalog enumerates seeded sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-claude-caps-sessions-"));
  try {
    const stateDir = join(root, "state");
    await seedSession(stateDir, "session-a");
    const capabilities = createClaudeCodeCleanerCapabilities({ stateDir });

    const sessions = await capabilities.sessionCatalog.listSessions();
    assert.ok(
      sessions.some((session) => session.sessionId === "session-a"),
      `expected session-a among ${JSON.stringify(sessions)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session catalog sorts valid state and isolates malformed records", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-claude-caps-sessions-bad-"));
  try {
    const stateDir = join(root, "state");
    const records = [
      { sessionId: "session-older", updatedAt: "2026-08-20T00:00:00.000Z" },
      { sessionId: "session-newer", updatedAt: "2026-08-21T00:00:00.000Z" },
      { sessionId: "session-mismatch", updatedAt: "2026-08-22T00:00:00.000Z" },
      { sessionId: "session-bad-time", updatedAt: "not-a-date" },
    ];
    for (const record of records) {
      const path = sessionSnapshotPath(stateDir, record.sessionId);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, JSON.stringify({
        ...record,
        ...(record.sessionId === "session-mismatch" ? { sessionId: "other-session" } : {}),
      }), "utf8");
    }
    const corruptPath = sessionSnapshotPath(stateDir, "session-corrupt");
    await writeFile(corruptPath, "{ not json", "utf8");
    await writeFile(
      join(corruptPath, "..", "bad%XX.json"),
      JSON.stringify({ sessionId: "bad", updatedAt: "2026-08-23T00:00:00.000Z" }),
      "utf8",
    );

    const capabilities = createClaudeCodeCleanerCapabilities({ stateDir });
    assert.deepEqual(await capabilities.sessionCatalog.listSessions(), [
      { sessionId: "session-newer", updatedAt: "2026-08-21T00:00:00.000Z" },
      { sessionId: "session-older", updatedAt: "2026-08-20T00:00:00.000Z" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schedule writer stores a pointer once and replays the identical request idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-claude-caps-schedule-"));
  try {
    const stateDir = join(root, "state");
    await seedSession(stateDir, "session-a");
    const capabilities = createClaudeCodeCleanerCapabilities({ stateDir });

    const request = {
      sessionId: "session-a",
      cleanPlanId: "plan-1",
      baseRevision: "revision-1",
      selectedTaskIds: ["task-a"],
      scheduledAt: "2026-01-01T00:00:00.000Z",
    };

    const first = await capabilities.scheduleWriter.writeSchedule(request);
    assert.equal(first.outcome, "stored");

    const replay = await capabilities.scheduleWriter.writeSchedule(request);
    assert.equal(replay.outcome, "unchanged");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
