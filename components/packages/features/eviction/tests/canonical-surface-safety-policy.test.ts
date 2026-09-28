/**
 * Regression matrix: canonical-surface/safety-policy.ts
 *
 * applySurfaceSafetyPolicy — non-tool items (not in any pair)
 *   N1 effective, not current, not checkpoint, completed, chars ≥ min → evict
 *   N2 not on the effective surface                                  → keep
 *   N3 current                                                       → keep
 *   N4 compaction_checkpoint                                         → keep
 *   N5 taskState ∈ {active, unresolved, blocked, current}            → keep
 *   N6 chars < min → keep;  N7 chars == min → evict (boundary)
 *   N8 missing chars treated as 0
 * applySurfaceSafetyPolicy — tool items (members of a pair)
 *   T1 closed pair, every member clearable, result ≥ min → result evict, call kept
 *   T2 closed pair, result < min                         → both kept, not deferred
 *   T3 non-closed pair                                   → all kept, call id deferred
 *   T4 closed pair, a member not clearable               → all kept, call id deferred
 *   T5 closed pair, a member missing from `items`        → all kept, call id deferred
 *   T6 shared envelope with one unsafe call              → sibling pairs deferred too
 * applySurfaceSafetyPolicy — output shape
 *   O1 evict/keep lists partition the items and keep item order
 *   O2 deferredCallIds are unique and sorted
 *   O3 every item gets an action; default is keep
 * classifySurfaceItemTaskState(turn, registry, currentTurn)
 *   K1 turn == currentTurn → current;  K2 turn > currentTurn → current
 *   K3 no owning task                                   → unresolved
 *   K4 every owner completed                            → completed
 *   K5 every owner evictable                            → completed
 *   K6 owners mix completed and evictable               → completed
 *   K7 any owner active                                 → active
 *   K8 an owner in no lifecycle bucket (e.g. blocked)   → unresolved
 *   K9 lookup key is `${sessionId}:t${turn}`
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createEmptySessionTaskRegistry, type SessionTaskRegistry } from "@lightrsi/history";

import {
  applySurfaceSafetyPolicy,
  buildToolPairsFromItems,
  classifySurfaceItemTaskState,
  type SurfaceSafetyItem,
  type SurfaceTaskState,
} from "../src/index.js";

type Item = SurfaceSafetyItem<string>;

function msg(id: string, patch: Partial<Item> = {}): Item {
  return { sourceEventSeq: id, kind: "message", taskState: "completed", current: false, chars: 500, ...patch };
}

function decide(items: Item[], options: { effective?: string[]; min?: number } = {}) {
  const effective = options.effective ?? items.map((it) => it.sourceEventSeq);
  return applySurfaceSafetyPolicy(items, effective, buildToolPairsFromItems(items, effective), options.min ?? 0);
}

describe("applySurfaceSafetyPolicy: non-tool items", () => {
  it("N1 a clearable message is evicted", () => {
    assert.deepEqual(decide([msg("m")], { min: 100 }).evictSeqs, ["m"]);
  });
  it("N2 a message off the effective surface is kept", () => {
    assert.deepEqual(decide([msg("m")], { effective: [] }).evictSeqs, []);
  });
  it("N3 a current message is kept", () => {
    assert.deepEqual(decide([msg("m", { current: true })]).evictSeqs, []);
  });
  it("N4 a compaction checkpoint is kept", () => {
    assert.deepEqual(decide([msg("m", { kind: "compaction_checkpoint" })]).evictSeqs, []);
  });
  it("N5 every non-completed task state is kept", () => {
    const states: SurfaceTaskState[] = ["active", "unresolved", "blocked", "current"];
    for (const taskState of states) {
      assert.deepEqual(decide([msg("m", { taskState })]).evictSeqs, [], taskState);
    }
  });
  it("N6 a message below minBlockChars is kept", () => {
    assert.deepEqual(decide([msg("m", { chars: 99 })], { min: 100 }).evictSeqs, []);
  });
  it("N7 a message exactly at minBlockChars is evicted", () => {
    assert.deepEqual(decide([msg("m", { chars: 100 })], { min: 100 }).evictSeqs, ["m"]);
  });
  it("N8 a message without chars counts as zero", () => {
    const item = msg("m");
    delete item.chars;
    assert.deepEqual(decide([item], { min: 1 }).evictSeqs, []);
    assert.deepEqual(decide([item], { min: 0 }).evictSeqs, ["m"]);
  });
});

describe("applySurfaceSafetyPolicy: tool items", () => {
  const call = (id: string, callIds: string[], patch: Partial<Item> = {}) => msg(id, { kind: "tool_call", callIds, chars: 20, ...patch });
  const result = (id: string, callId: string, patch: Partial<Item> = {}) => msg(id, { kind: "tool_result", callIds: [callId], chars: 5000, ...patch });

  it("T1 a closed, clearable pair evicts the result and keeps the call envelope", () => {
    const d = decide([call("a", ["c"]), result("r", "c")], { min: 1000 });
    assert.deepEqual(d.evictSeqs, ["r"]);
    assert.deepEqual(d.keepSeqs, ["a"]);
    assert.deepEqual(d.deferredCallIds, []);
  });
  it("T2 a closed pair whose result is below minBlockChars is kept but not deferred", () => {
    const d = decide([call("a", ["c"]), result("r", "c", { chars: 10 })], { min: 1000 });
    assert.deepEqual(d.evictSeqs, []);
    assert.deepEqual(d.deferredCallIds, []);
  });
  it("T3 a non-closed pair is kept and deferred", () => {
    const d = decide([result("r", "c")]);
    assert.deepEqual(d.evictSeqs, []);
    assert.deepEqual(d.deferredCallIds, ["c"]);
  });
  it("T4 a closed pair with a non-clearable member is kept and deferred", () => {
    const d = decide([call("a", ["c"], { taskState: "active" }), result("r", "c")]);
    assert.deepEqual(d.evictSeqs, []);
    assert.deepEqual(d.deferredCallIds, ["c"]);
  });
  it("T5 a closed pair with a member missing from the item list is kept and deferred", () => {
    const items = [call("a", ["c"]), result("r", "c")];
    const pairs = buildToolPairsFromItems(items, ["a", "r"]);
    const d = applySurfaceSafetyPolicy([items[1]!], ["a", "r"], pairs, 0);
    assert.deepEqual(d.evictSeqs, []);
    assert.deepEqual(d.deferredCallIds, ["c"]);
  });
  it("T6 one unsafe call in a shared envelope defers every sibling pair", () => {
    const d = decide([
      call("a", ["c1", "c2"]),
      result("r1", "c1"),
      result("r2", "c2", { taskState: "active" }),
    ]);
    assert.deepEqual(d.evictSeqs, []);
    assert.deepEqual(d.deferredCallIds, ["c1", "c2"]);
  });
});

describe("applySurfaceSafetyPolicy: output shape", () => {
  it("O1 evict and keep lists partition the items in item order", () => {
    const d = decide([msg("m1"), msg("m2", { current: true }), msg("m3")]);
    assert.deepEqual(d.evictSeqs, ["m1", "m3"]);
    assert.deepEqual(d.keepSeqs, ["m2"]);
  });
  it("O2 deferred call ids are unique and sorted", () => {
    const d = decide([
      msg("a", { kind: "tool_call", callIds: ["z", "b"] }),
      msg("r", { kind: "tool_result", callIds: ["z"], taskState: "active" }),
    ]);
    assert.deepEqual(d.deferredCallIds, ["b", "z"]);
  });
  it("O3 every item receives an action", () => {
    const d = decide([msg("m1"), msg("m2", { current: true })]);
    assert.deepEqual([...d.action.entries()], [["m1", "evict"], ["m2", "keep"]]);
  });
});

describe("classifySurfaceItemTaskState", () => {
  const SESSION = "s";
  function registry(patch: Partial<SessionTaskRegistry> = {}): SessionTaskRegistry {
    return { ...createEmptySessionTaskRegistry(SESSION), ...patch };
  }
  const owned = (taskIds: string[], patch: Partial<SessionTaskRegistry> = {}) =>
    registry({ turnToTaskIds: { [`${SESSION}:t1`]: taskIds }, ...patch });

  it("K1 the current turn is current", () => {
    assert.deepEqual(classifySurfaceItemTaskState(2, owned(["t"], { completedTaskIds: ["t"] }), 2), { taskState: "current", current: true });
  });
  it("K2 a turn after the current turn is current", () => {
    assert.deepEqual(classifySurfaceItemTaskState(3, registry(), 2), { taskState: "current", current: true });
  });
  it("K3 a turn with no owning task is unresolved", () => {
    assert.deepEqual(classifySurfaceItemTaskState(1, registry(), 2), { taskState: "unresolved", current: false });
  });
  it("K4 a turn whose owners are all completed is completed", () => {
    assert.equal(classifySurfaceItemTaskState(1, owned(["t"], { completedTaskIds: ["t"] }), 2).taskState, "completed");
  });
  it("K5 a turn whose owners are all evictable is completed", () => {
    assert.equal(classifySurfaceItemTaskState(1, owned(["t"], { evictableTaskIds: ["t"] }), 2).taskState, "completed");
  });
  it("K6 a turn whose owners mix completed and evictable is completed", () => {
    const r = owned(["a", "b"], { completedTaskIds: ["a"], evictableTaskIds: ["b"] });
    assert.equal(classifySurfaceItemTaskState(1, r, 2).taskState, "completed");
  });
  it("K7 a turn with any active owner is active", () => {
    const r = owned(["a", "b"], { completedTaskIds: ["a"], activeTaskIds: ["b"] });
    assert.equal(classifySurfaceItemTaskState(1, r, 2).taskState, "active");
  });
  it("K8 a turn with an owner in no lifecycle bucket is unresolved", () => {
    const r = owned(["a", "b"], { completedTaskIds: ["a"] });
    assert.equal(classifySurfaceItemTaskState(1, r, 2).taskState, "unresolved");
  });
  it("K9 the lookup key is scoped by session id", () => {
    const r = registry({ completedTaskIds: ["t"], turnToTaskIds: { "other:t1": ["t"] } });
    assert.equal(classifySurfaceItemTaskState(1, r, 2).taskState, "unresolved");
  });
});
