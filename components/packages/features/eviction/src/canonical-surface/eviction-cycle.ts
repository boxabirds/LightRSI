/**
 * Host-neutral canonical-surface eviction cycle.
 *
 *   host snapshot → shared estimator → registry update → safety filter → host transaction
 *
 * It is a pure pipeline over an in-hand registry: the registry comes in as a
 * parameter and the updated registry comes back out. Loading and persisting it,
 * building the snapshot and surface items, and applying the transaction stay
 * with the host adapter.
 *
 * Lifted from the DeepSeek Harness adapter (`eviction-cycle.ts`, `runDshEvictionCycle`)
 * without behaviour change. The DSH-specific parts (event parsing, native
 * replacement envelopes, `surfaceOp` appends) remain in that adapter.
 */

import {
  applySessionTaskRegistryPatch,
  buildDeltaViewFromRawSemanticSnapshot,
  type RawSemanticSnapshot,
  type SessionTaskRegistry,
} from "@lightrsi/history";
import type { TaskStateEstimator } from "../types.js";
import { mapTaskUpdatesToRegistryPatch } from "../task-update-mapper.js";
import {
  applySurfaceSafetyPolicy,
  classifySurfaceItemTaskState,
  type SurfaceItemKind,
  type SurfaceSafetyDecision,
  type SurfaceSafetyItem,
} from "./safety-policy.js";
import type { ToolPair } from "./tool-closure.js";

/** A model-visible item on the host's current surface. */
export interface SurfaceCycleItem<TId extends string | number> {
  sourceEventSeq: TId;
  /** Turn number used for `${sessionId}:t${turn}` registry lookups. */
  turn: number;
  kind: SurfaceItemKind;
  callIds?: readonly string[];
  chars: number;
}

/** The only field of a host transaction result the cycle reads. */
export interface SurfaceTransactionOutcome {
  status: "committed" | "partial" | "deferred" | "empty";
}

export interface CanonicalEvictionCycleResult<TId extends string | number, TResult extends SurfaceTransactionOutcome> {
  registry: SessionTaskRegistry;
  result: TResult;
  registryPersisted: boolean;
  /** Coarse status for logging: why nothing was applied, when applicable. */
  status: "applied" | "deferred" | "empty" | "no-delta";
  decision?: SurfaceSafetyDecision<TId>;
}

export async function runCanonicalEvictionCycle<TId extends string | number, TResult extends SurfaceTransactionOutcome>(params: {
  snapshot: RawSemanticSnapshot;
  registry: SessionTaskRegistry;
  estimator: TaskStateEstimator;
  items: readonly SurfaceCycleItem<TId>[];
  effectiveSeqs: readonly TId[];
  pairs: ReadonlyMap<string, ToolPair<TId>>;
  currentTurn: number;
  minBlockChars?: number;
  /** Track task state without modifying the canonical model-visible surface. */
  allowSurfaceMutation?: boolean;
  /** Orders the evict list handed to `apply` (defaults to item order). */
  compareSeqs?: (left: TId, right: TId) => number;
  persistRegistry?: (registry: SessionTaskRegistry, expectedVersion: number) => void | Promise<void>;
  /** Host transaction: apply the safe evict set. Must be all-or-report (no silent partials). */
  apply(evictSeqs: TId[]): TResult | Promise<TResult>;
  emptyResult(): TResult;
}): Promise<CanonicalEvictionCycleResult<TId, TResult>> {
  const delta = buildDeltaViewFromRawSemanticSnapshot(params.snapshot, {
    fromTurnSeqExclusive: params.registry.lastProcessedTurnSeq,
  });
  let registry = params.registry;
  let registryPersistedBeforeMutation = false;
  let registryExpectedVersion = params.registry.version;
  if (delta.coveredTurnAbsIds.length > 0) {
    const output = await params.estimator.estimate({ registry: params.registry, delta });
    const { patch } = mapTaskUpdatesToRegistryPatch({
      registry: params.registry,
      updates: output.taskUpdates,
      coveredTurnAbsIds: delta.coveredTurnAbsIds,
      toTurnSeqInclusive: delta.toTurnSeqInclusive,
    });
    registry = applySessionTaskRegistryPatch(params.registry, patch);
    // Registry CAS is a precondition for canonical mutation. Persist task state
    // first, but keep the watermark behind until the surface transaction lands;
    // otherwise a partial apply would permanently hide its unprocessed tail.
    const pendingRegistry = {
      ...registry,
      lastProcessedTurnSeq: params.registry.lastProcessedTurnSeq,
    };
    await params.persistRegistry?.(pendingRegistry, params.registry.version);
    registry = pendingRegistry;
    registryPersistedBeforeMutation = params.persistRegistry !== undefined;
    registryExpectedVersion = pendingRegistry.version;
  }

  const safetyItems: SurfaceSafetyItem<TId>[] = params.items.map((it) => {
    const c = classifySurfaceItemTaskState(it.turn, registry, params.currentTurn);
    return {
      sourceEventSeq: it.sourceEventSeq,
      kind: it.kind,
      taskState: c.taskState,
      current: c.current,
      callIds: it.callIds,
      chars: it.chars,
    };
  });

  const decision = applySurfaceSafetyPolicy(
    safetyItems,
    params.effectiveSeqs,
    params.pairs,
    params.minBlockChars ?? 0,
  );
  if (params.compareSeqs) {
    decision.evictSeqs.sort(params.compareSeqs);
    decision.keepSeqs.sort(params.compareSeqs);
  }

  const advance = async (status: "empty" | "no-delta"): Promise<CanonicalEvictionCycleResult<TId, TResult>> => {
    registry = { ...registry, lastProcessedTurnSeq: delta.toTurnSeqInclusive };
    if (registryPersistedBeforeMutation && params.persistRegistry) {
      await params.persistRegistry(registry, registryExpectedVersion);
    }
    return { registry, result: params.emptyResult(), registryPersisted: true, status, decision };
  };

  if (decision.evictSeqs.length === 0) {
    return advance(delta.coveredTurnAbsIds.length === 0 ? "no-delta" : "empty");
  }

  // Context Cleaner needs the same completed-task registry as automatic
  // eviction, but a Cleaner-only profile must never remove context before the
  // user makes an explicit selection.
  if (params.allowSurfaceMutation === false) {
    return advance("empty");
  }

  const result = await params.apply([...decision.evictSeqs]);

  const shouldAdvanceWatermark = result.status === "committed";
  const finalRegistry = shouldAdvanceWatermark
    ? { ...registry, lastProcessedTurnSeq: delta.toTurnSeqInclusive }
    : registry;
  let registryPersisted = true;
  if (shouldAdvanceWatermark && registryPersistedBeforeMutation && params.persistRegistry) {
    try {
      await params.persistRegistry(finalRegistry, registryExpectedVersion);
    } catch {
      // Replacements already landed. Keep the in-memory result truthful and let
      // the next cycle recover the stale watermark from the canonical surface.
      registryPersisted = false;
    }
  }

  return {
    registry: finalRegistry,
    result,
    registryPersisted,
    status: result.status === "committed" || result.status === "partial" ? "applied" : "deferred",
    decision,
  };
}
