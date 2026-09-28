/**
 * Regression matrix: DSH wrappers over the shared canonical-surface eviction core
 * (refactor that moved tool-closure / safety-policy / cycle into @lightrsi/eviction).
 *
 * W1 buildToolPairs (DSH events) equals buildToolPairsFromItems over
 *    describeEffectiveItems for every oracle fixture case
 * W2 applySafetyPolicy (DSH) equals applySurfaceSafetyPolicy fed with DSH pairs,
 *    for every fixture case, with evict/keep sorted by numeric seq
 * W3 classifyPair / isEvictablePair delegate to the shared classifier for every
 *    (calls, results) partition
 * W4 isEstimatorConfigured / createDshTaskStateEstimator agree with the shared
 *    estimator helpers for every presence combination of baseUrl/apiKey/model
 *    and for enabled=false
 * W5 DSH still exports the pre-refactor public names (API compatibility)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  applySurfaceSafetyPolicy,
  buildToolPairsFromItems,
  classifyToolPair,
  createConfiguredTaskStateEstimator,
  isEvictableToolPair,
  isTaskStateEstimatorConfigured,
  type ToolPairStatus,
} from "@lightrsi/eviction";

import { describeEffectiveItems } from "../src/eviction-cycle.js";
import { createDshTaskStateEstimator, isEstimatorConfigured } from "../src/lifecycle-estimator.js";
import { applySafetyPolicy, type SafetyItem, type TaskState } from "../src/safety-policy.js";
import { buildToolPairs, classifyPair, isEvictablePair } from "../src/tool-closure.js";
import * as cycleModule from "../src/eviction-cycle.js";
import * as closureModule from "../src/tool-closure.js";
import * as safetyModule from "../src/safety-policy.js";
import type { DshEstimatorConfig } from "../src/config.js";
import type { DshLogEventWithMeta } from "../src/types.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/session-events.json", import.meta.url), "utf8"),
) as {
  cases: Array<{
    id: string;
    events: DshLogEventWithMeta[];
    effectiveEventSeqs: number[];
    expected: { items: Array<{ sourceEventSeq: number; kind: string; taskState: TaskState; current: boolean }> };
  }>;
};

function itemsFor(c: (typeof fixture.cases)[number]): SafetyItem[] {
  const callIdsBySeq = new Map<number, string[]>();
  for (const [callId, pair] of buildToolPairs(c.events, c.effectiveEventSeqs)) {
    for (const seq of [...pair.callSeqs, ...pair.resultSeqs]) {
      callIdsBySeq.set(seq, [...(callIdsBySeq.get(seq) ?? []), callId]);
    }
  }
  return c.expected.items.map((it) => ({
    sourceEventSeq: it.sourceEventSeq,
    kind: it.kind,
    taskState: it.taskState,
    current: it.current,
    callIds: callIdsBySeq.get(it.sourceEventSeq),
    chars: 10,
  }));
}

describe("W1 DSH tool pairs match shared pairs derived from surface items", () => {
  for (const c of fixture.cases) {
    it(c.id, () => {
      const dsh = buildToolPairs(c.events, c.effectiveEventSeqs);
      const items = describeEffectiveItems(c.events, c.effectiveEventSeqs).map((it) => ({
        sourceEventSeq: it.seq,
        kind: it.kind,
        callIds: it.callIds,
      }));
      const shared = buildToolPairsFromItems(items, c.effectiveEventSeqs);
      assert.deepEqual(
        [...dsh.entries()].sort(([a], [b]) => a.localeCompare(b)),
        [...shared.entries()].sort(([a], [b]) => a.localeCompare(b)),
      );
    });
  }
});

describe("W2 DSH safety policy equals the shared policy", () => {
  for (const c of fixture.cases) {
    for (const minBlockChars of [0, 11]) {
      it(`${c.id} minBlockChars=${minBlockChars}`, () => {
        const items = itemsFor(c);
        const dsh = applySafetyPolicy(items, c.effectiveEventSeqs, c.events, minBlockChars);
        const shared = applySurfaceSafetyPolicy(items, c.effectiveEventSeqs, buildToolPairs(c.events, c.effectiveEventSeqs), minBlockChars);
        assert.deepEqual(dsh.evictSeqs, [...shared.evictSeqs].sort((a, b) => a - b));
        assert.deepEqual(dsh.keepSeqs, [...shared.keepSeqs].sort((a, b) => a - b));
        assert.deepEqual(dsh.deferredCallIds, shared.deferredCallIds);
        assert.deepEqual([...dsh.action.entries()].sort(), [...shared.action.entries()].sort());
      });
    }
  }
});

describe("W3 DSH pair classification delegates to the shared classifier", () => {
  const partitions: Array<[number[], number[]]> = [[[1], [2]], [[1, 2], [3]], [[1], [2, 3]], [[], [2]], [[1], []], [[], []]];
  for (const [calls, results] of partitions) {
    it(`calls=${calls.length} results=${results.length}`, () => {
      assert.equal(classifyPair(calls, results), classifyToolPair(calls, results));
    });
  }
  it("every status has the same evictability", () => {
    const statuses: ToolPairStatus[] = ["closed", "orphan_result", "missing_result", "duplicate_call", "duplicate_result"];
    for (const status of statuses) assert.equal(isEvictablePair(status), isEvictableToolPair(status), status);
  });
});

describe("W4 DSH estimator construction agrees with the shared helpers", () => {
  const base: DshEstimatorConfig = {
    enabled: true,
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    model: "m",
    requestTimeoutMs: 1000,
    batchTurns: 5,
    evictionLookaheadTurns: 3,
  } as DshEstimatorConfig;
  for (const mask of [0, 1, 2, 3, 4, 5, 6, 7]) {
    it(`presence mask ${mask.toString(2).padStart(3, "0")} (baseUrl,apiKey,model)`, () => {
      const cfg = {
        ...base,
        baseUrl: mask & 4 ? base.baseUrl : "",
        apiKey: mask & 2 ? base.apiKey : "",
        model: mask & 1 ? base.model : "",
      } as DshEstimatorConfig;
      assert.equal(isEstimatorConfigured(cfg), isTaskStateEstimatorConfigured(cfg));
      assert.equal(Boolean(createDshTaskStateEstimator(cfg)), Boolean(createConfiguredTaskStateEstimator(cfg)));
    });
  }
  it("enabled=false yields no estimator on both paths", () => {
    const cfg = { ...base, enabled: false } as DshEstimatorConfig;
    assert.equal(createDshTaskStateEstimator(cfg), undefined);
    assert.equal(createConfiguredTaskStateEstimator(cfg), undefined);
  });
});

describe("W5 pre-refactor public names are still exported", () => {
  it("tool-closure", () => {
    for (const name of ["buildToolPairs", "classifyPair", "isEvictablePair", "resultCallId", "assistantCallIds"]) {
      assert.equal(typeof (closureModule as Record<string, unknown>)[name], "function", name);
    }
  });
  it("safety-policy", () => {
    for (const name of ["applySafetyPolicy", "findDamagedPersistenceRecords"]) {
      assert.equal(typeof (safetyModule as Record<string, unknown>)[name], "function", name);
    }
  });
  it("eviction-cycle", () => {
    for (const name of ["runDshEvictionCycle", "describeEffectiveItems"]) {
      assert.equal(typeof (cycleModule as Record<string, unknown>)[name], "function", name);
    }
  });
});
