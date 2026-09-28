/**
 * Regression matrix: canonical-surface/eviction-cycle.ts (runCanonicalEvictionCycle)
 *
 * Estimation (partitioned by whether the snapshot has turns past the watermark)
 *   D1 delta present  → estimator called once with {registry, delta}; task state
 *                       persisted first with the OLD watermark and expectedVersion
 *   D2 no delta       → estimator not called; nothing persisted before mutation
 * Decision / mutation (partitioned by safety outcome × mutation permission × host result)
 *   M1 nothing to evict, delta present → status "empty", watermark advanced, persisted
 *   M2 nothing to evict, no delta      → status "no-delta", apply not called
 *   M3 evictions, mutation disallowed  → apply not called, status "empty", watermark advanced
 *   M4 host commits                    → status "applied", watermark advanced & persisted
 *   M5 host partial                    → status "applied", watermark NOT advanced
 *   M6 host defers                     → status "deferred", watermark NOT advanced
 *   M7 host empty                      → status "deferred", watermark NOT advanced
 * Persistence failures
 *   P1 persist throws before mutation  → cycle rejects (caller fails open)
 *   P2 persist throws after a commit   → resolves, registryPersisted=false
 *   P3 no persistRegistry supplied     → registryPersisted=true, nothing thrown
 * Inputs forwarded unchanged
 *   F1 compareSeqs orders the list handed to apply; apply gets a copy
 *   F2 minBlockChars reaches the safety policy
 *   F3 without compareSeqs, apply receives item order
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createEmptySessionTaskRegistry,
  type RawSemanticSnapshot,
  type SessionTaskRegistry,
} from "@lightrsi/history";

import {
  buildToolPairsFromItems,
  runCanonicalEvictionCycle,
  type SemanticTaskUpdate,
  type SurfaceCycleItem,
  type SurfaceTransactionOutcome,
  type TaskStateEstimatorInput,
} from "../src/index.js";

const SESSION = "s1";

function items(): SurfaceCycleItem<string>[] {
  return [
    { sourceEventSeq: "u1", turn: 1, kind: "message", chars: 40 },
    { sourceEventSeq: "a1", turn: 1, kind: "tool_call", callIds: ["c1"], chars: 20 },
    { sourceEventSeq: "r1", turn: 1, kind: "tool_result", callIds: ["c1"], chars: 5000 },
    { sourceEventSeq: "a1b", turn: 1, kind: "message", chars: 300 },
    { sourceEventSeq: "u2", turn: 2, kind: "message", chars: 30 },
  ];
}

function snapshot(lastTurnSeq = 2): RawSemanticSnapshot {
  const anchor = (turnSeq: number, role: "user" | "assistant" | "tool") => ({
    sessionId: SESSION, turnAbsId: `${SESSION}:t${turnSeq}`, turnSeq, role,
  });
  return {
    sessionId: SESSION,
    lastTurnSeq,
    messages: [
      { anchor: anchor(1, "user"), role: "user", text: "read the config" },
      { anchor: anchor(1, "assistant"), role: "assistant", text: "config says x" },
      { anchor: anchor(2, "user"), role: "user", text: "next" },
    ],
    toolCalls: [{ anchor: anchor(1, "assistant"), toolCallId: "c1", toolName: "read", argumentsSummary: "{}" }],
    toolResults: [{ anchor: anchor(1, "tool"), toolCallId: "c1", toolName: "read", status: "success", fullText: "x", summary: "x" }],
  };
}

function estimator(updates: SemanticTaskUpdate[] = [{
  taskId: "task-config",
  objective: "read the config",
  lifecycle: "completed",
  coveredTurnAbsIds: [`${SESSION}:t1`],
  completionEvidence: ["assistant reported config value"],
}]) {
  const calls: TaskStateEstimatorInput[] = [];
  return {
    calls,
    estimate(input: TaskStateEstimatorInput) {
      calls.push(input);
      return { baseVersion: input.registry.version, taskUpdates: updates };
    },
  };
}

/** A registry that already knows t1 is completed and has processed through t2. */
function processedRegistry(): SessionTaskRegistry {
  return {
    ...createEmptySessionTaskRegistry(SESSION),
    completedTaskIds: ["task-config"],
    turnToTaskIds: { [`${SESSION}:t1`]: ["task-config"] },
    lastProcessedTurnSeq: 2,
  };
}

type RunOptions = Partial<Parameters<typeof runCanonicalEvictionCycle<string, SurfaceTransactionOutcome>>[0]>;

function run(options: RunOptions = {}) {
  const list = options.items ?? items();
  const effective = list.map((it) => it.sourceEventSeq);
  return runCanonicalEvictionCycle<string, SurfaceTransactionOutcome>({
    snapshot: snapshot(),
    registry: createEmptySessionTaskRegistry(SESSION),
    estimator: estimator(),
    items: list,
    effectiveSeqs: effective,
    pairs: buildToolPairsFromItems(list, effective),
    currentTurn: 2,
    minBlockChars: 256,
    emptyResult: () => ({ status: "empty" }),
    apply: () => ({ status: "committed" }),
    ...options,
  });
}

describe("estimation", () => {
  it("D1 a delta calls the estimator once and persists task state with the old watermark first", async () => {
    const est = estimator();
    const persisted: Array<{ registry: SessionTaskRegistry; expectedVersion: number }> = [];
    await run({ estimator: est, persistRegistry: (registry, expectedVersion) => { persisted.push({ registry, expectedVersion }); } });
    assert.equal(est.calls.length, 1);
    assert.deepEqual(est.calls[0]?.delta.coveredTurnAbsIds, [`${SESSION}:t1`, `${SESSION}:t2`]);
    assert.equal(persisted[0]?.registry.lastProcessedTurnSeq, 0);
    assert.equal(persisted[0]?.expectedVersion, 0);
    assert.deepEqual(persisted[0]?.registry.completedTaskIds, ["task-config"]);
  });
  it("D2 no delta skips the estimator and persists nothing before mutation", async () => {
    const est = estimator();
    const persisted: SessionTaskRegistry[] = [];
    await run({ estimator: est, registry: processedRegistry(), persistRegistry: (registry) => { persisted.push(registry); } });
    assert.equal(est.calls.length, 0);
    assert.equal(persisted.length, 0);
  });
});

describe("decision and mutation", () => {
  it("M1 nothing to evict with a delta advances and persists the watermark", async () => {
    const persisted: SessionTaskRegistry[] = [];
    const cycle = await run({ estimator: estimator([]), persistRegistry: (registry) => { persisted.push(registry); } });
    assert.equal(cycle.status, "empty");
    assert.equal(cycle.registry.lastProcessedTurnSeq, 2);
    assert.equal(persisted.at(-1)?.lastProcessedTurnSeq, 2);
  });
  it("M2 nothing to evict without a delta reports no-delta and never applies", async () => {
    let applied = false;
    const registry = { ...createEmptySessionTaskRegistry(SESSION), lastProcessedTurnSeq: 2 };
    const cycle = await run({ registry, apply: () => { applied = true; return { status: "committed" }; } });
    assert.equal(cycle.status, "no-delta");
    assert.equal(applied, false);
  });
  it("M3 evictions with mutation disallowed track state but never apply", async () => {
    let applied = false;
    const cycle = await run({ allowSurfaceMutation: false, apply: () => { applied = true; return { status: "committed" }; } });
    assert.equal(applied, false);
    assert.equal(cycle.status, "empty");
    assert.equal(cycle.registry.lastProcessedTurnSeq, 2);
    assert.deepEqual(cycle.registry.completedTaskIds, ["task-config"]);
  });
  it("M4 a committed host transaction advances and persists the watermark", async () => {
    const persisted: SessionTaskRegistry[] = [];
    const cycle = await run({ persistRegistry: (registry) => { persisted.push(registry); } });
    assert.equal(cycle.status, "applied");
    assert.equal(cycle.registry.lastProcessedTurnSeq, 2);
    assert.equal(persisted.at(-1)?.lastProcessedTurnSeq, 2);
    assert.equal(cycle.registryPersisted, true);
  });
  for (const [label, status, expected] of [
    ["M5 partial", "partial", "applied"],
    ["M6 deferred", "deferred", "deferred"],
    ["M7 empty", "empty", "deferred"],
  ] as const) {
    it(`${label} host result keeps the watermark behind`, async () => {
      const persisted: SessionTaskRegistry[] = [];
      const cycle = await run({ apply: () => ({ status }), persistRegistry: (registry) => { persisted.push(registry); } });
      assert.equal(cycle.status, expected);
      assert.equal(cycle.registry.lastProcessedTurnSeq, 0);
      assert.ok(persisted.every((registry) => registry.lastProcessedTurnSeq === 0));
    });
  }
});

describe("persistence failures", () => {
  it("P1 a failure persisting task state before mutation rejects", async () => {
    await assert.rejects(run({ persistRegistry: () => { throw new Error("cas"); } }), /cas/);
  });
  it("P2 a failure persisting the watermark after a commit is reported, not thrown", async () => {
    let calls = 0;
    const cycle = await run({
      persistRegistry: () => {
        calls += 1;
        if (calls > 1) throw new Error("late");
      },
    });
    assert.equal(cycle.status, "applied");
    assert.equal(cycle.registryPersisted, false);
  });
  it("P3 without persistRegistry the cycle still completes", async () => {
    const cycle = await run({ persistRegistry: undefined });
    assert.equal(cycle.status, "applied");
    assert.equal(cycle.registryPersisted, true);
  });
});

describe("forwarded inputs", () => {
  it("F1 compareSeqs orders the evict list and apply receives a copy", async () => {
    let received: string[] = [];
    const cycle = await run({
      compareSeqs: (a, b) => b.localeCompare(a),
      apply(evictSeqs) {
        received = evictSeqs;
        evictSeqs.push("mutated");
        return { status: "committed" };
      },
    });
    assert.deepEqual(received.slice(0, 2), ["r1", "a1b"]);
    assert.deepEqual(cycle.decision?.evictSeqs, ["r1", "a1b"]);
  });
  it("F2 minBlockChars reaches the safety policy", async () => {
    let received: string[] = [];
    await run({ minBlockChars: 1000, apply(evictSeqs) { received = evictSeqs; return { status: "committed" }; } });
    assert.deepEqual(received, ["r1"]);
  });
  it("F3 without compareSeqs apply receives item order", async () => {
    let received: string[] = [];
    await run({ apply(evictSeqs) { received = evictSeqs; return { status: "committed" }; } });
    assert.deepEqual(received, ["r1", "a1b"]);
  });
});
