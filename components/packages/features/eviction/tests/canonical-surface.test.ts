import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createEmptySessionTaskRegistry,
  type RawSemanticSnapshot,
  type SessionTaskRegistry,
} from "@lightrsi/history";

import {
  applySurfaceSafetyPolicy,
  buildToolPairsFromItems,
  classifySurfaceItemTaskState,
  createConfiguredTaskStateEstimator,
  isTaskStateEstimatorConfigured,
  runCanonicalEvictionCycle,
  type SemanticTaskUpdate,
  type SurfaceCycleItem,
  type SurfaceSafetyItem,
  type SurfaceTransactionOutcome,
} from "../src/index.js";

const SESSION = "s1";

/** Two turns: t1 is a finished task with one tool pair, t2 is current. */
function items(): SurfaceCycleItem<string>[] {
  return [
    { sourceEventSeq: "u1", turn: 1, kind: "message", chars: 40 },
    { sourceEventSeq: "a1", turn: 1, kind: "tool_call", callIds: ["c1"], chars: 20 },
    { sourceEventSeq: "r1", turn: 1, kind: "tool_result", callIds: ["c1"], chars: 5000 },
    { sourceEventSeq: "a1b", turn: 1, kind: "message", chars: 300 },
    { sourceEventSeq: "u2", turn: 2, kind: "message", chars: 30 },
  ];
}

function snapshot(): RawSemanticSnapshot {
  const anchor = (turnSeq: number, role: "user" | "assistant" | "tool") => ({
    sessionId: SESSION, turnAbsId: `${SESSION}:t${turnSeq}`, turnSeq, role,
  });
  return {
    sessionId: SESSION,
    lastTurnSeq: 2,
    messages: [
      { anchor: anchor(1, "user"), role: "user", text: "read the config" },
      { anchor: anchor(1, "assistant"), role: "assistant", text: "done, config says x" },
      { anchor: anchor(2, "user"), role: "user", text: "now something else" },
    ],
    toolCalls: [{ anchor: anchor(1, "assistant"), toolCallId: "c1", toolName: "read", argumentsSummary: "{}" }],
    toolResults: [{
      anchor: anchor(1, "tool"), toolCallId: "c1", toolName: "read", status: "success", fullText: "x".repeat(5000), summary: "x",
    }],
  };
}

function completedT1Estimator() {
  const taskUpdates: SemanticTaskUpdate[] = [{
    taskId: "task-config",
    objective: "read the config",
    lifecycle: "completed",
    coveredTurnAbsIds: [`${SESSION}:t1`],
    completionEvidence: ["assistant reported config value"],
  }];
  return { estimate: () => ({ baseVersion: 0, taskUpdates }) };
}

describe("canonical-surface tool closure", () => {
  it("pairs string-id items and flags unclosed groups", () => {
    const pairs = buildToolPairsFromItems([
      { sourceEventSeq: "a", kind: "tool_call", callIds: ["c1", "c2"] },
      { sourceEventSeq: "b", kind: "tool_result", callIds: ["c1"] },
      { sourceEventSeq: "c", kind: "tool_result", callIds: ["c3"] },
    ], ["a", "b", "c"]);
    assert.equal(pairs.get("c1")?.status, "closed");
    assert.equal(pairs.get("c2")?.status, "missing_result");
    assert.equal(pairs.get("c3")?.status, "orphan_result");
  });

  it("ignores items that are not on the effective surface", () => {
    const pairs = buildToolPairsFromItems([
      { sourceEventSeq: "a", kind: "tool_call", callIds: ["c1"] },
      { sourceEventSeq: "b", kind: "tool_result", callIds: ["c1"] },
    ], ["b"]);
    assert.equal(pairs.get("c1")?.status, "orphan_result");
  });
});

describe("canonical-surface safety policy", () => {
  it("evicts only a closed, completed tool result above minBlockChars and never the call envelope", () => {
    const safety: SurfaceSafetyItem<string>[] = [
      { sourceEventSeq: "a1", kind: "tool_call", callIds: ["c1"], taskState: "completed", current: false, chars: 20 },
      { sourceEventSeq: "r1", kind: "tool_result", callIds: ["c1"], taskState: "completed", current: false, chars: 5000 },
      { sourceEventSeq: "u2", kind: "message", taskState: "current", current: true, chars: 30 },
    ];
    const effective = ["a1", "r1", "u2"];
    const decision = applySurfaceSafetyPolicy(safety, effective, buildToolPairsFromItems(safety, effective), 1000);
    assert.deepEqual(decision.evictSeqs, ["r1"]);
    assert.deepEqual(decision.keepSeqs.sort(), ["a1", "u2"]);
  });

  it("defers every sibling when a shared assistant envelope has an unsafe call", () => {
    const safety: SurfaceSafetyItem<string>[] = [
      { sourceEventSeq: "a1", kind: "tool_call", callIds: ["c1", "c2"], taskState: "completed", current: false, chars: 20 },
      { sourceEventSeq: "r1", kind: "tool_result", callIds: ["c1"], taskState: "completed", current: false, chars: 5000 },
    ];
    const decision = applySurfaceSafetyPolicy(safety, ["a1", "r1"], buildToolPairsFromItems(safety, ["a1", "r1"]));
    assert.deepEqual(decision.evictSeqs, []);
    assert.deepEqual(decision.deferredCallIds, ["c1", "c2"]);
  });

  it("classifies task state from the registry only", () => {
    const registry: SessionTaskRegistry = {
      ...createEmptySessionTaskRegistry(SESSION),
      completedTaskIds: ["t"],
      turnToTaskIds: { [`${SESSION}:t1`]: ["t"] },
    };
    assert.deepEqual(classifySurfaceItemTaskState(1, registry, 2), { taskState: "completed", current: false });
    assert.deepEqual(classifySurfaceItemTaskState(2, registry, 2), { taskState: "current", current: true });
    assert.deepEqual(classifySurfaceItemTaskState(0, registry, 2), { taskState: "unresolved", current: false });
  });
});

describe("canonical-surface eviction cycle", () => {
  it("estimates, persists, applies the safe set, and advances the watermark", async () => {
    const persisted: SessionTaskRegistry[] = [];
    let applied: string[] = [];
    const list = items();
    const cycle = await runCanonicalEvictionCycle({
      snapshot: snapshot(),
      registry: createEmptySessionTaskRegistry(SESSION),
      estimator: completedT1Estimator(),
      items: list,
      effectiveSeqs: list.map((it) => it.sourceEventSeq),
      pairs: buildToolPairsFromItems(list, list.map((it) => it.sourceEventSeq)),
      currentTurn: 2,
      minBlockChars: 256,
      persistRegistry: (registry) => { persisted.push(registry); },
      emptyResult: (): SurfaceTransactionOutcome => ({ status: "empty" }),
      apply(evictSeqs) {
        applied = evictSeqs;
        return { status: "committed" as const };
      },
    });
    assert.equal(cycle.status, "applied");
    assert.deepEqual(applied, ["r1", "a1b"]);
    assert.equal(cycle.registry.lastProcessedTurnSeq, 2);
    // Task state lands first with the old watermark, then the watermark advances.
    assert.equal(persisted[0]?.lastProcessedTurnSeq, 0);
    assert.equal(persisted.at(-1)?.lastProcessedTurnSeq, 2);
  });

  it("tracks task state without mutating when surface mutation is not allowed", async () => {
    let called = false;
    const list = items();
    const cycle = await runCanonicalEvictionCycle({
      snapshot: snapshot(),
      registry: createEmptySessionTaskRegistry(SESSION),
      estimator: completedT1Estimator(),
      items: list,
      effectiveSeqs: list.map((it) => it.sourceEventSeq),
      pairs: buildToolPairsFromItems(list, list.map((it) => it.sourceEventSeq)),
      currentTurn: 2,
      allowSurfaceMutation: false,
      emptyResult: (): SurfaceTransactionOutcome => ({ status: "empty" }),
      apply() { called = true; return { status: "committed" as const }; },
    });
    assert.equal(called, false);
    assert.equal(cycle.status, "empty");
    assert.deepEqual(cycle.registry.completedTaskIds, ["task-config"]);
  });

  it("keeps the watermark behind when the host transaction defers", async () => {
    const list = items();
    const cycle = await runCanonicalEvictionCycle({
      snapshot: snapshot(),
      registry: createEmptySessionTaskRegistry(SESSION),
      estimator: completedT1Estimator(),
      items: list,
      effectiveSeqs: list.map((it) => it.sourceEventSeq),
      pairs: buildToolPairsFromItems(list, list.map((it) => it.sourceEventSeq)),
      currentTurn: 2,
      emptyResult: (): SurfaceTransactionOutcome => ({ status: "empty" }),
      apply: () => ({ status: "deferred" as const }),
    });
    assert.equal(cycle.status, "deferred");
    assert.equal(cycle.registry.lastProcessedTurnSeq, 0);
  });
});

describe("canonical-surface estimator config", () => {
  it("requires baseUrl, apiKey and model", () => {
    assert.equal(isTaskStateEstimatorConfigured({ baseUrl: "http://x", apiKey: "k" }), false);
    assert.equal(isTaskStateEstimatorConfigured({ baseUrl: "http://x", apiKey: "k", model: "m" }), true);
    assert.equal(createConfiguredTaskStateEstimator({ baseUrl: "http://x", apiKey: "k" }), undefined);
    assert.equal(createConfiguredTaskStateEstimator({ enabled: false, baseUrl: "http://x", apiKey: "k", model: "m" }), undefined);
    assert.ok(createConfiguredTaskStateEstimator({ baseUrl: "http://x", apiKey: "k", model: "m" }));
  });
});
