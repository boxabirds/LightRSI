/**
 * Tool call/result closure (Task-R3, part 1).
 *
 * Groups model-visible tool protocol blocks by `callId`. DSH's durable
 * `tool/call` event is log-only; the actual call on the canonical surface is a
 * `tool-call` block inside `assistant/message`. Results are `tool/result`
 * surface events. Only a strict one-call/one-result pair is safe to rewrite.
 *
 * This mirrors the pairing scheme the shared fixture oracle uses
 * (tests/session-event-fixtures.test.ts): tool/call → data.callId; tool/result
 * → message.source.callId (fallback: the tool-result block's toolCallId).
 *
 * Pair classification is the shared canonical-surface closure in
 * `@lightrsi/eviction`; only DSH event parsing lives here.
 */

import {
  assembleToolPairs,
  classifyToolPair,
  isEvictableToolPair,
  type ToolPair as SharedToolPair,
  type ToolPairStatus as SharedToolPairStatus,
} from "@lightrsi/eviction";

export type ToolPairStatus = SharedToolPairStatus;

export type ToolPair = SharedToolPair<number>;

/** Minimal event shape the closure logic reads. */
export interface ClosureEvent {
  seq: number;
  type: string;
  data?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve a tool/result event's callId (source.callId, else the tool-result block). */
export function resultCallId(event: ClosureEvent): string | undefined {
  const data = isObject(event.data) ? event.data : {};
  const message = isObject(data.message) ? data.message : {};
  const source = isObject(message.source) ? message.source : {};
  if (typeof source.callId === "string" && source.callId.length > 0) return source.callId;

  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (isObject(block) && block.type === "tool-result" && typeof block.toolCallId === "string") {
      return block.toolCallId;
    }
  }
  return undefined;
}

/** Resolve all tool-call blocks carried by a surface assistant message. */
export function assistantCallIds(event: ClosureEvent): string[] {
  const data = isObject(event.data) ? event.data : {};
  const message = isObject(data.message) ? data.message : {};
  const content = Array.isArray(message.content) ? message.content : [];
  return content.flatMap((block) => (
    isObject(block)
      && block.type === "tool-call"
      && typeof block.id === "string"
      && block.id.length > 0
      ? [block.id]
      : []
  ));
}

export function classifyPair(callSeqs: readonly number[], resultSeqs: readonly number[]): ToolPairStatus {
  return classifyToolPair(callSeqs, resultSeqs);
}

/** Only a strict closed pair may be evicted (and only as a unit). */
export function isEvictablePair(status: ToolPairStatus): boolean {
  return isEvictableToolPair(status);
}

/**
 * Build the tool-pair map over the events that are currently on the surface
 * (`effectiveSeqs`). Events not on the surface never participate in a pair.
 */
export function buildToolPairs(
  events: readonly ClosureEvent[],
  effectiveSeqs: Iterable<number>,
): Map<string, ToolPair> {
  const effective = new Set(effectiveSeqs);
  const calls = new Map<string, number[]>();
  const results = new Map<string, number[]>();

  for (const event of events) {
    if (!effective.has(event.seq)) continue;

    if (event.type === "assistant/message") {
      for (const id of assistantCallIds(event)) {
        (calls.get(id) ?? calls.set(id, []).get(id)!).push(event.seq);
      }
    } else if (event.type === "tool/result") {
      const id = resultCallId(event);
      if (id) (results.get(id) ?? results.set(id, []).get(id)!).push(event.seq);
    }
  }

  return assembleToolPairs(calls, results, (a, b) => a - b);
}
