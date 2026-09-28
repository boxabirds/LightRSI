/**
 * Canonical-surface eviction glue for transcript-based in-process hosts.
 *
 * The host supplies its model-visible surface as ordered `CanonicalSurfaceEntry`
 * records (canonical message + stable entry id + user-turn number). This module
 * builds the shared estimator snapshot and surface items, runs the shared
 * `runCanonicalEvictionCycle` from `@lightrsi/eviction` (estimator → registry →
 * safety policy), and hands the host a replacement per evicted entry. Each
 * replacement archives the original through the shared artifact store so
 * `memory_fault_recover` can restore it.
 *
 * Applying the replacement is host-specific: pi appends native `context_edit`
 * entries, OpenCode re-applies a durable overlay request-locally.
 */
import { archiveContent, buildRecoveryHint } from "@lightrsi/artifact-store";
import {
  buildToolPairsFromItems,
  createConfiguredTaskStateEstimator,
  runCanonicalEvictionCycle,
  type CanonicalEvictionCycleResult,
  type SurfaceCycleItem,
  type SurfaceTransactionOutcome,
  type TaskStateEstimator,
} from "@lightrsi/eviction";
import {
  loadSessionTaskRegistry,
  persistSessionTaskRegistry,
  type RawSemanticMessageRecord,
  type RawSemanticSnapshot,
  type RawSemanticToolCallRecord,
  type RawSemanticToolResultRecord,
  type SessionTaskRegistry,
  type TurnAnchor,
} from "@lightrsi/history";
import type { RuntimeMessage } from "@lightrsi/kernel";
import type { CanonicalAdapterConfig } from "./config.js";

export type CanonicalSurfaceEntry = {
  /** Host-stable id of the entry (pi entry id, OpenCode message/part id). */
  id: string;
  /** User-turn number (1-based; turn N starts at the Nth user message). */
  turn: number;
  message: RuntimeMessage;
  /** Compaction/branch summaries: never evicted. */
  checkpoint?: boolean;
  /** Already replaced by an earlier eviction: never evicted again. */
  alreadyEvicted?: boolean;
};

export type EvictionReplacement = {
  id: string;
  kind: string;
  /** Model-visible replacement text (stub + recovery hint). */
  text: string;
  originalChars: number;
  dataKey: string;
};

const SUMMARY_MAX_CHARS = 600;

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= SUMMARY_MAX_CHARS ? trimmed : `${trimmed.slice(0, SUMMARY_MAX_CHARS)}...`;
}

function anchor(sessionId: string, turnSeq: number, role: TurnAnchor["role"]): TurnAnchor {
  return { sessionId, turnAbsId: `${sessionId}:t${turnSeq}`, turnSeq, role };
}

export function canonicalVisibleText(message: RuntimeMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) => (block.type === "text" || block.type === "tool_result" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

function toolCallIdsOf(message: RuntimeMessage): string[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((block) => (block.type === "tool_call" && block.toolCallId ? [block.toolCallId] : []));
}

function toolResultIdsOf(message: RuntimeMessage): string[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((block) => (block.type === "tool_result" && block.toolCallId ? [block.toolCallId] : []));
}

export function surfaceItemKind(entry: CanonicalSurfaceEntry): string {
  if (entry.checkpoint) return "compaction_checkpoint";
  if (entry.message.role === "tool") return "tool_result";
  if (entry.message.role === "assistant" && toolCallIdsOf(entry.message).length > 0) return "tool_call";
  return "message";
}

/** Estimator snapshot over the current surface (shared `RawSemanticSnapshot`). */
export function buildCanonicalRawSemanticSnapshot(
  sessionId: string,
  entries: readonly CanonicalSurfaceEntry[],
): RawSemanticSnapshot {
  const messages: RawSemanticMessageRecord[] = [];
  const toolCalls: RawSemanticToolCallRecord[] = [];
  const toolResults: RawSemanticToolResultRecord[] = [];
  const toolNameByCallId = new Map<string, string>();
  let lastTurnSeq = 0;

  for (const entry of entries) {
    lastTurnSeq = Math.max(lastTurnSeq, entry.turn);
    const { message } = entry;
    if (message.role === "user" || message.role === "assistant") {
      const textBlocks = typeof message.content === "string"
        ? message.content
        : message.content.map((block) => (block.type === "text" ? block.text : "")).filter(Boolean).join("\n");
      if (textBlocks.trim()) {
        messages.push({ anchor: anchor(sessionId, entry.turn, message.role), role: message.role, text: textBlocks.trim() });
      }
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type !== "tool_call") continue;
          const args = block.argumentsText ?? (block.argumentsJson ? JSON.stringify(block.argumentsJson) : "");
          toolNameByCallId.set(block.toolCallId, block.toolName);
          toolCalls.push({
            anchor: anchor(sessionId, entry.turn, "assistant"),
            toolCallId: block.toolCallId,
            toolName: block.toolName,
            argumentsText: args,
            argumentsSummary: truncate(args),
          });
        }
      }
    } else if (message.role === "tool" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type !== "tool_result") continue;
        const callId = block.toolCallId ?? "";
        toolResults.push({
          anchor: anchor(sessionId, entry.turn, "tool"),
          toolCallId: callId,
          toolName: block.toolName ?? toolNameByCallId.get(callId) ?? "",
          status: block.status === "error" ? "error" : "success",
          fullText: block.text,
          summary: truncate(block.text),
        });
      }
    }
  }
  return { sessionId, lastTurnSeq, messages, toolCalls, toolResults };
}

export function buildCanonicalSurfaceItems(entries: readonly CanonicalSurfaceEntry[]): SurfaceCycleItem<string>[] {
  return entries.map((entry) => {
    const kind = surfaceItemKind(entry);
    const callIds = kind === "tool_call" ? toolCallIdsOf(entry.message) : kind === "tool_result" ? toolResultIdsOf(entry.message) : [];
    return {
      sourceEventSeq: entry.id,
      turn: entry.turn,
      kind,
      ...(callIds.length > 0 ? { callIds } : {}),
      chars: canonicalVisibleText(entry.message).length,
    };
  });
}

/**
 * Archive the original and build the stub the model sees instead. Throws when
 * the archive cannot be written: an eviction without a recoverable original is
 * never applied.
 */
export async function buildEvictionReplacement(params: {
  sessionId: string;
  entry: CanonicalSurfaceEntry;
}): Promise<EvictionReplacement> {
  const kind = surfaceItemKind(params.entry);
  const originalText = canonicalVisibleText(params.entry.message);
  const dataKey = `evicted:${params.entry.id}`;
  const segmentId = `evict-${params.entry.id}`;
  const toolName = Array.isArray(params.entry.message.content)
    ? params.entry.message.content.find((block) => block.type === "tool_result")?.toolName
    : undefined;
  let hint = "";
  if (originalText.length > 0) {
    const location = await archiveContent({
      sessionId: params.sessionId,
      segmentId,
      sourcePass: "lifecycle_eviction",
      toolName: toolName ?? kind,
      dataKey,
      originalText,
      metadata: { entryId: params.entry.id, kind, turn: params.entry.turn },
    });
    hint = buildRecoveryHint({
      dataKey,
      originalSize: originalText.length,
      archivePath: location.archivePath,
      sourceLabel: "Evicted completed-task context",
    });
  }
  return {
    id: params.entry.id,
    kind,
    text: `[evicted: ${kind} ${params.entry.id}]${hint}`,
    originalChars: originalText.length,
    dataKey,
  };
}

export function createCanonicalEstimator(config: CanonicalAdapterConfig): TaskStateEstimator | undefined {
  return createConfiguredTaskStateEstimator({
    enabled: config.taskStateEstimator.enabled,
    baseUrl: config.taskStateEstimator.baseUrl,
    apiKey: config.taskStateEstimator.apiKey,
    model: config.taskStateEstimator.model,
    requestTimeoutMs: config.taskStateEstimator.requestTimeoutMs,
    batchTurns: config.taskStateEstimator.batchTurns,
    evictionLookaheadTurns: config.taskStateEstimator.evictionLookaheadTurns,
    inputMode: config.taskStateEstimator.inputMode,
    lifecycleMode: config.taskStateEstimator.lifecycleMode,
    evidenceMode: config.taskStateEstimator.evidenceMode,
  });
}

export type CanonicalEvictionOutcome = SurfaceTransactionOutcome & {
  replacements: EvictionReplacement[];
};

/**
 * One eviction cycle over the host's current surface. `apply` receives the
 * archived replacements and must report whether they all landed.
 */
export async function runCanonicalSurfaceEviction(params: {
  sessionId: string;
  entries: readonly CanonicalSurfaceEntry[];
  config: CanonicalAdapterConfig;
  estimator: TaskStateEstimator;
  apply(replacements: EvictionReplacement[]): Promise<SurfaceTransactionOutcome["status"]> | SurfaceTransactionOutcome["status"];
  registryStore?: {
    load(sessionId: string): Promise<SessionTaskRegistry> | SessionTaskRegistry;
    persist(registry: SessionTaskRegistry, expectedVersion: number): Promise<void> | void;
  };
}): Promise<CanonicalEvictionCycleResult<string, CanonicalEvictionOutcome>> {
  const { sessionId, entries, config } = params;
  const store = params.registryStore ?? {
    load: (id: string) => loadSessionTaskRegistry(config.stateDir, id),
    persist: async (registry: SessionTaskRegistry, expectedVersion: number) => {
      await persistSessionTaskRegistry(config.stateDir, registry, { expectedVersion });
    },
  };
  const registry = await store.load(sessionId);
  const effective = entries.filter((entry) => !entry.alreadyEvicted);
  const items = buildCanonicalSurfaceItems(effective);
  const effectiveIds = items.map((item) => item.sourceEventSeq);
  const byId = new Map(effective.map((entry) => [entry.id, entry]));
  const currentTurn = entries.reduce((max, entry) => Math.max(max, entry.turn), 0);

  return runCanonicalEvictionCycle<string, CanonicalEvictionOutcome>({
    snapshot: buildCanonicalRawSemanticSnapshot(sessionId, entries),
    registry,
    estimator: params.estimator,
    items,
    effectiveSeqs: effectiveIds,
    pairs: buildToolPairsFromItems(items, effectiveIds),
    currentTurn,
    minBlockChars: config.eviction.minBlockChars,
    allowSurfaceMutation: config.eviction.enabled,
    persistRegistry: (next, expectedVersion) => store.persist(next, expectedVersion),
    emptyResult: () => ({ status: "empty", replacements: [] }),
    async apply(evictIds) {
      const replacements: EvictionReplacement[] = [];
      for (const id of evictIds) {
        const entry = byId.get(id);
        if (!entry) return { status: "deferred", replacements: [] };
        try {
          replacements.push(await buildEvictionReplacement({ sessionId, entry }));
        } catch {
          // No recoverable archive → no eviction for this batch (watermark stays).
          return { status: "deferred", replacements: [] };
        }
      }
      const status = await params.apply(replacements);
      return { status, replacements: status === "committed" ? replacements : [] };
    },
  });
}
