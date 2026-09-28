/**
 * Independent eviction safety policy (Task-R3, part 2).
 *
 * The estimator only proposes candidates (via task lifecycle). This filter runs
 * independently before any surface mutation and NEVER trusts the model's
 * self-reported state. It clears an item for eviction only if ALL hold:
 *   - the item is on the current surface (effective),
 *   - its task is `completed` (not current / active / blocked / unresolved),
 *   - it is not part of the current turn,
 *   - it is not a canonical compaction checkpoint,
 *   - if it is a tool call/result, its callId group is strictly closed
 *     (1 call + 1 result) and every item in that group is itself clearable —
 *     otherwise the whole group is deferred.
 *
 * Anything failing these is kept. This matches the shared fixture oracle
 * (tests/fixtures/session-events.json).
 */

import {
  applySurfaceSafetyPolicy,
  type SurfaceItemKind,
  type SurfaceSafetyAction,
  type SurfaceSafetyItem,
  type SurfaceTaskState,
} from "@lightrsi/eviction";

import { buildToolPairs, type ClosureEvent } from "./tool-closure.js";

export type TaskState = SurfaceTaskState;

export type ItemKind = SurfaceItemKind;

export type SafetyItem = SurfaceSafetyItem<number>;

export type SafetyAction = SurfaceSafetyAction;

export interface SafetyDecision {
  action: Map<number, SafetyAction>;
  evictSeqs: number[];
  keepSeqs: number[];
  /** callIds whose group was protected because it wasn't strictly closed. */
  deferredCallIds: string[];
}

/**
 * Apply the safety policy. `events` is only needed to re-derive tool pairs over
 * the effective surface; item task state comes from the caller (the estimator /
 * registry), never re-inferred here. The policy itself is the shared
 * canonical-surface policy in `@lightrsi/eviction`.
 */
export function applySafetyPolicy(
  items: readonly SafetyItem[],
  effectiveSeqs: Iterable<number>,
  events: readonly ClosureEvent[],
  minBlockChars = 0,
): SafetyDecision {
  const effective = [...effectiveSeqs];
  const pairs = buildToolPairs(events, effective);
  const decision = applySurfaceSafetyPolicy(items, effective, pairs, minBlockChars);
  decision.evictSeqs.sort((a, b) => a - b);
  decision.keepSeqs.sort((a, b) => a - b);
  return decision;
}

/**
 * Detect malformed persisted event records without exposing their content.
 * A record is valid iff it is an object carrying a numeric `seq` and a string
 * `type`. Returns the indexes of records that fail — nothing from the content.
 */
export function findDamagedPersistenceRecords(records: readonly unknown[]): number[] {
  const damaged: number[] = [];
  records.forEach((record, index) => {
    const ok =
      typeof record === "object" &&
      record !== null &&
      !Array.isArray(record) &&
      typeof (record as { seq?: unknown }).seq === "number" &&
      typeof (record as { type?: unknown }).type === "string";
    if (!ok) damaged.push(index);
  });
  return damaged;
}
