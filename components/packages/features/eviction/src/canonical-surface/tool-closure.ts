/**
 * Host-neutral tool call/result closure for canonical-surface eviction.
 *
 * A tool protocol group is keyed by call id. Only a strict one-call/one-result
 * pair may be rewritten, and only as a unit. Hosts supply the call and result
 * memberships (DSH derives them from its durable events; transcript-based hosts
 * derive them from surface items), so this module never parses host shapes.
 *
 * Lifted from the DeepSeek Harness adapter (`tool-closure.ts`) without
 * behaviour change.
 */

export type ToolPairStatus =
  | "closed"
  | "orphan_result"
  | "missing_result"
  | "duplicate_call"
  | "duplicate_result";

export interface ToolPair<TId extends string | number = number> {
  callId: string;
  callSeqs: TId[];
  resultSeqs: TId[];
  status: ToolPairStatus;
}

export function classifyToolPair(
  callSeqs: readonly unknown[],
  resultSeqs: readonly unknown[],
): ToolPairStatus {
  if (callSeqs.length > 1) return "duplicate_call";
  if (resultSeqs.length > 1) return "duplicate_result";
  if (callSeqs.length === 0) return "orphan_result";
  if (resultSeqs.length === 0) return "missing_result";
  return "closed";
}

/** Only a strictly closed pair may be evicted (and only as a unit). */
export function isEvictableToolPair(status: ToolPairStatus): boolean {
  return status === "closed";
}

/**
 * Assemble pairs from per-call memberships. `compare` orders member ids within a
 * pair (DSH: numeric seq order; transcript hosts: surface order).
 */
export function assembleToolPairs<TId extends string | number>(
  calls: ReadonlyMap<string, readonly TId[]>,
  results: ReadonlyMap<string, readonly TId[]>,
  compare: (left: TId, right: TId) => number,
): Map<string, ToolPair<TId>> {
  const pairs = new Map<string, ToolPair<TId>>();
  for (const callId of new Set([...calls.keys(), ...results.keys()])) {
    const callSeqs = [...(calls.get(callId) ?? [])].sort(compare);
    const resultSeqs = [...(results.get(callId) ?? [])].sort(compare);
    pairs.set(callId, { callId, callSeqs, resultSeqs, status: classifyToolPair(callSeqs, resultSeqs) });
  }
  return pairs;
}

/** Minimal item view used to derive pairs directly from surface items. */
export interface ToolPairSourceItem<TId extends string | number> {
  sourceEventSeq: TId;
  kind: string;
  callIds?: readonly string[];
}

/**
 * Derive pairs from surface items: `tool_call` items carry the call ids of their
 * assistant envelope, `tool_result` items carry their single result call id.
 * Items not in `effectiveSeqs` never participate.
 */
export function buildToolPairsFromItems<TId extends string | number>(
  items: readonly ToolPairSourceItem<TId>[],
  effectiveSeqs: Iterable<TId>,
): Map<string, ToolPair<TId>> {
  const effective = new Set(effectiveSeqs);
  const order = new Map<TId, number>();
  const calls = new Map<string, TId[]>();
  const results = new Map<string, TId[]>();
  items.forEach((item, index) => {
    order.set(item.sourceEventSeq, index);
    if (!effective.has(item.sourceEventSeq)) return;
    const target = item.kind === "tool_call" ? calls : item.kind === "tool_result" ? results : undefined;
    if (!target) return;
    for (const id of item.callIds ?? []) {
      if (!id) continue;
      (target.get(id) ?? target.set(id, []).get(id)!).push(item.sourceEventSeq);
    }
  });
  return assembleToolPairs(calls, results, (left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
}
