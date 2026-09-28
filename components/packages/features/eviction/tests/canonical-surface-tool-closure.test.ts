/**
 * Regression matrix: canonical-surface/tool-closure.ts
 *
 * classifyToolPair(calls, results)        — partitioned by (#calls, #results)
 *   C1 calls=1 results=1            → closed
 *   C2 calls≥2 (any results)        → duplicate_call      (checked first)
 *   C3 calls≤1 results≥2            → duplicate_result    (checked before C4)
 *   C4 calls=0 results=1            → orphan_result
 *   C5 calls=1 results=0            → missing_result
 *   C6 calls=0 results=0            → orphan_result       (degenerate; pinned)
 * isEvictableToolPair(status)             — one case per status value
 *   E1 closed → true;  E2 every other status → false
 * assembleToolPairs(calls, results, cmp)
 *   A1 key in both maps → one pair with both memberships
 *   A2 key only in calls / only in results → pair with empty other side
 *   A3 member ids are ordered by `cmp`, not insertion order
 *   A4 input arrays are not mutated
 * buildToolPairsFromItems(items, effective)
 *   B1 tool_call items contribute calls, tool_result items contribute results
 *   B2 message / compaction_checkpoint items contribute nothing
 *   B3 items outside `effective` contribute nothing
 *   B4 empty call ids are ignored
 *   B5 one envelope carrying several call ids joins each pair
 *   B6 members are ordered by item position
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assembleToolPairs,
  buildToolPairsFromItems,
  classifyToolPair,
  isEvictableToolPair,
  type ToolPairStatus,
} from "../src/index.js";

describe("classifyToolPair", () => {
  it("C1 one call and one result is closed", () => {
    assert.equal(classifyToolPair([1], [2]), "closed");
  });
  it("C2 two or more calls is duplicate_call regardless of results", () => {
    assert.equal(classifyToolPair([1, 2], []), "duplicate_call");
    assert.equal(classifyToolPair([1, 2], [3]), "duplicate_call");
    assert.equal(classifyToolPair([1, 2], [3, 4]), "duplicate_call");
  });
  it("C3 at most one call with two or more results is duplicate_result", () => {
    assert.equal(classifyToolPair([1], [2, 3]), "duplicate_result");
    assert.equal(classifyToolPair([], [2, 3]), "duplicate_result");
  });
  it("C4 no call with one result is orphan_result", () => {
    assert.equal(classifyToolPair([], [2]), "orphan_result");
  });
  it("C5 one call without a result is missing_result", () => {
    assert.equal(classifyToolPair([1], []), "missing_result");
  });
  it("C6 no call and no result is orphan_result", () => {
    assert.equal(classifyToolPair([], []), "orphan_result");
  });
});

describe("isEvictableToolPair", () => {
  it("E1 closed is evictable", () => {
    assert.equal(isEvictableToolPair("closed"), true);
  });
  it("E2 every non-closed status is not evictable", () => {
    const others: ToolPairStatus[] = ["orphan_result", "missing_result", "duplicate_call", "duplicate_result"];
    for (const status of others) assert.equal(isEvictableToolPair(status), false, status);
  });
});

describe("assembleToolPairs", () => {
  const numeric = (a: number, b: number) => a - b;
  it("A1 a call id present in both maps yields one pair with both sides", () => {
    const pairs = assembleToolPairs(new Map([["c", [1]]]), new Map([["c", [2]]]), numeric);
    assert.deepEqual([...pairs.values()], [{ callId: "c", callSeqs: [1], resultSeqs: [2], status: "closed" }]);
  });
  it("A2 a call id present on one side yields a pair with the other side empty", () => {
    const pairs = assembleToolPairs(new Map([["a", [1]]]), new Map([["b", [2]]]), numeric);
    assert.deepEqual(pairs.get("a"), { callId: "a", callSeqs: [1], resultSeqs: [], status: "missing_result" });
    assert.deepEqual(pairs.get("b"), { callId: "b", callSeqs: [], resultSeqs: [2], status: "orphan_result" });
  });
  it("A3 members are ordered by the comparator", () => {
    const pairs = assembleToolPairs(new Map([["c", [9, 3]]]), new Map([["c", [7, 5]]]), numeric);
    assert.deepEqual(pairs.get("c")?.callSeqs, [3, 9]);
    assert.deepEqual(pairs.get("c")?.resultSeqs, [5, 7]);
  });
  it("A4 the input membership arrays are not mutated", () => {
    const calls = [9, 3];
    assembleToolPairs(new Map([["c", calls]]), new Map(), numeric);
    assert.deepEqual(calls, [9, 3]);
  });
});

describe("buildToolPairsFromItems", () => {
  it("B1 tool_call items are calls and tool_result items are results", () => {
    const pairs = buildToolPairsFromItems([
      { sourceEventSeq: "a", kind: "tool_call", callIds: ["c1"] },
      { sourceEventSeq: "r", kind: "tool_result", callIds: ["c1"] },
    ], ["a", "r"]);
    assert.deepEqual(pairs.get("c1"), { callId: "c1", callSeqs: ["a"], resultSeqs: ["r"], status: "closed" });
  });
  it("B2 message and checkpoint items never join a pair", () => {
    const pairs = buildToolPairsFromItems([
      { sourceEventSeq: "m", kind: "message", callIds: ["c1"] },
      { sourceEventSeq: "k", kind: "compaction_checkpoint", callIds: ["c1"] },
    ], ["m", "k"]);
    assert.equal(pairs.size, 0);
  });
  it("B3 items outside the effective surface never join a pair", () => {
    const pairs = buildToolPairsFromItems([
      { sourceEventSeq: "a", kind: "tool_call", callIds: ["c1"] },
      { sourceEventSeq: "r", kind: "tool_result", callIds: ["c1"] },
    ], ["r"]);
    assert.deepEqual(pairs.get("c1"), { callId: "c1", callSeqs: [], resultSeqs: ["r"], status: "orphan_result" });
  });
  it("B4 empty call ids are ignored", () => {
    const pairs = buildToolPairsFromItems([{ sourceEventSeq: "a", kind: "tool_call", callIds: [""] }], ["a"]);
    assert.equal(pairs.size, 0);
  });
  it("B5 one envelope with several call ids joins each of those pairs", () => {
    const pairs = buildToolPairsFromItems([
      { sourceEventSeq: "a", kind: "tool_call", callIds: ["c1", "c2"] },
      { sourceEventSeq: "r1", kind: "tool_result", callIds: ["c1"] },
      { sourceEventSeq: "r2", kind: "tool_result", callIds: ["c2"] },
    ], ["a", "r1", "r2"]);
    assert.deepEqual(pairs.get("c1")?.callSeqs, ["a"]);
    assert.deepEqual(pairs.get("c2")?.callSeqs, ["a"]);
    assert.equal(pairs.get("c1")?.status, "closed");
    assert.equal(pairs.get("c2")?.status, "closed");
  });
  it("B6 members are ordered by their position in the item list", () => {
    const pairs = buildToolPairsFromItems([
      { sourceEventSeq: "z", kind: "tool_result", callIds: ["c1"] },
      { sourceEventSeq: "a", kind: "tool_result", callIds: ["c1"] },
    ], ["a", "z"]);
    assert.deepEqual(pairs.get("c1")?.resultSeqs, ["z", "a"]);
  });
});
