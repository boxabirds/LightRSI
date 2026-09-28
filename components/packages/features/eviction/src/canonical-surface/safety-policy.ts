/**
 * Independent canonical-surface eviction safety policy.
 *
 * The estimator only proposes candidates (via task lifecycle). This filter runs
 * independently before any surface mutation and never trusts the model's
 * self-reported state. It clears an item for eviction only if all hold:
 *   - the item is on the current surface (effective),
 *   - its task is `completed` (not current / active / blocked / unresolved),
 *   - it is not part of the current turn,
 *   - it is not a canonical compaction checkpoint,
 *   - if it is a tool call/result, its call group is strictly closed
 *     (1 call + 1 result) and every item in that group is itself clearable;
 *     otherwise the whole group is deferred.
 *
 * Lifted from the DeepSeek Harness adapter (`safety-policy.ts`) without
 * behaviour change. Tool pairs are supplied by the host instead of being derived
 * from DSH events here.
 */

import type { SessionTaskRegistry } from "@lightrsi/history";
import { isEvictableToolPair, type ToolPair } from "./tool-closure.js";

export type SurfaceTaskState = "completed" | "unresolved" | "current" | "active" | "blocked";

export type SurfaceItemKind = "message" | "tool_call" | "tool_result" | "compaction_checkpoint" | string;

export interface SurfaceSafetyItem<TId extends string | number = number> {
  sourceEventSeq: TId;
  kind: SurfaceItemKind;
  taskState: SurfaceTaskState;
  current: boolean;
  /** Present for tool_call / tool_result items; ties the item to its pair. */
  callIds?: readonly string[];
  /** Visible characters that would actually be replaced. */
  chars?: number;
}

export type SurfaceSafetyAction = "evict" | "keep";

export interface SurfaceSafetyDecision<TId extends string | number = number> {
  action: Map<TId, SurfaceSafetyAction>;
  /** In item order (callers may re-sort, e.g. DSH sorts by numeric seq). */
  evictSeqs: TId[];
  keepSeqs: TId[];
  /** callIds whose group was protected because it wasn't strictly closed. */
  deferredCallIds: string[];
}

/** True when an item is individually clearable (ignoring tool-group coupling). */
function isClearable<TId extends string | number>(item: SurfaceSafetyItem<TId>, effective: Set<TId>): boolean {
  if (!effective.has(item.sourceEventSeq)) return false;
  if (item.current) return false;
  if (item.kind === "compaction_checkpoint") return false;
  return item.taskState === "completed";
}

export function applySurfaceSafetyPolicy<TId extends string | number>(
  items: readonly SurfaceSafetyItem<TId>[],
  effectiveSeqs: Iterable<TId>,
  pairs: ReadonlyMap<string, ToolPair<TId>>,
  minBlockChars = 0,
): SurfaceSafetyDecision<TId> {
  const effective = new Set(effectiveSeqs);
  const action = new Map<TId, SurfaceSafetyAction>();
  for (const item of items) action.set(item.sourceEventSeq, "keep"); // default keep

  const itemsBySeq = new Map(items.map((it) => [it.sourceEventSeq, it]));
  const deferredCallIds: string[] = [];

  // Tool calls live inside assistant envelopes. Preserve that envelope and only
  // rewrite a result when its pair is strict and both sides are safe.
  const tooledSeqs = new Set<TId>();
  const unsafeToolSeqs = new Set<TId>();
  const unsafeCallEnvelopeSeqs = new Set<TId>();
  for (const pair of pairs.values()) {
    const memberSeqs = [...pair.callSeqs, ...pair.resultSeqs];
    for (const seq of memberSeqs) tooledSeqs.add(seq);

    const everyMemberClearable = memberSeqs.every((seq) => {
      const it = itemsBySeq.get(seq);
      return it ? isClearable(it, effective) : false;
    });

    if (!isEvictableToolPair(pair.status) || !everyMemberClearable) {
      for (const seq of memberSeqs) unsafeToolSeqs.add(seq);
      for (const seq of pair.callSeqs) unsafeCallEnvelopeSeqs.add(seq);
      deferredCallIds.push(pair.callId);
    }
  }

  // One assistant message may carry multiple calls. If any call in that shared
  // envelope is unsafe, no sibling result may be rewritten independently.
  for (const pair of pairs.values()) {
    if (!pair.callSeqs.some((seq) => unsafeCallEnvelopeSeqs.has(seq))) continue;
    for (const seq of [...pair.callSeqs, ...pair.resultSeqs]) unsafeToolSeqs.add(seq);
    deferredCallIds.push(pair.callId);
  }

  for (const item of items) {
    if (!tooledSeqs.has(item.sourceEventSeq)) continue;
    const resultIsLargeEnough = item.kind === "tool_result" && (item.chars ?? 0) >= minBlockChars;
    action.set(
      item.sourceEventSeq,
      resultIsLargeEnough && !unsafeToolSeqs.has(item.sourceEventSeq) ? "evict" : "keep",
    );
  }

  // Non-tool items: evict iff individually clearable.
  for (const item of items) {
    if (tooledSeqs.has(item.sourceEventSeq)) continue;
    action.set(
      item.sourceEventSeq,
      isClearable(item, effective) && (item.chars ?? 0) >= minBlockChars ? "evict" : "keep",
    );
  }

  const evictSeqs: TId[] = [];
  const keepSeqs: TId[] = [];
  for (const [seq, act] of action) (act === "evict" ? evictSeqs : keepSeqs).push(seq);
  const uniqueDeferredCallIds = [...new Set(deferredCallIds)].sort();

  return { action, evictSeqs, keepSeqs, deferredCallIds: uniqueDeferredCallIds };
}

/**
 * Classify a surface item's task state from the registry (never re-inferred from
 * content). Items at or after `currentTurn` are current. An item is completed
 * only if every owning task is completed/evictable and none is active.
 */
export function classifySurfaceItemTaskState(
  turn: number,
  registry: SessionTaskRegistry,
  currentTurn: number,
): { taskState: SurfaceTaskState; current: boolean } {
  if (turn >= currentTurn) return { taskState: "current", current: true };

  const turnAbsId = `${registry.sessionId}:t${turn}`;
  const taskIds = registry.turnToTaskIds[turnAbsId] ?? [];
  const evictable = new Set(registry.evictableTaskIds);
  const completed = new Set(registry.completedTaskIds);
  const active = new Set(registry.activeTaskIds);

  if (taskIds.length > 0 && taskIds.every((id) => evictable.has(id) || completed.has(id)) && !taskIds.some((id) => active.has(id))) {
    return { taskState: "completed", current: false };
  }
  if (taskIds.some((id) => active.has(id))) return { taskState: "active", current: false };
  return { taskState: "unresolved", current: false };
}
