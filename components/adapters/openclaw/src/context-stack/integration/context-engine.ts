/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  rewriteCanonicalState,
  syncCanonicalStateFromTranscript,
} from "../page-out/canonical-rewrite-adapter.js";
import {
  appendCanonicalTranscript,
  estimateMessagesChars,
  saveCanonicalState,
  loadCanonicalState,
} from "@lightrsi/history";
import { appendModuleObservation } from "@lightrsi/product-surface";
import { enqueueEvictedTasksForProceduralMemory } from "./procedural-memory.js";
import { runHistoryEvictionIfEnabled } from "./history-eviction-runner.js";
import { runHistoryModules } from "./module-orchestrator.js";
import { TOKENPILOT_HISTORY_MODULE_IDS } from "@lightrsi/tokenpilot";
import { applyScheduledOpenClawCleanUnlocked, hasOpenClawCleanerApplyIntent } from "../../context-cleaner/runtime.js";
import { readOpenClawCleanerSchedule } from "../../context-cleaner/scheduler.js";
import { withOpenClawCleanerSessionLock } from "../../context-cleaner/session-lock.js";

export function createPluginContextEngine(cfg: any, logger: any, deps: any) {
  const cleanerRequests = new Set<string>();
  const canonicalMessageTaskIdsBound = (message: Record<string, unknown>): string[] =>
    deps.canonicalMessageTaskIds(message, deps.asRecord);

  async function preserveCanonical(sessionId: string, runtimeMessages: any[]) {
    const state = await loadCanonicalState(cfg.stateDir, sessionId);
    return {
      state: {
        ...(state ?? {
          version: 1 as const, sessionId, messages: runtimeMessages,
          seenMessageIds: [], updatedAt: new Date().toISOString(),
        }),
        messages: runtimeMessages.length > 0 ? runtimeMessages : state?.messages ?? [],
      },
      changed: false,
    };
  }

  async function syncAndEvict(
    sessionId: string,
    runtimeMessages: any[] = [],
    runtimeMessageIdPrefix = "runtime",
    executeCleaner = false,
  ) {
    return withOpenClawCleanerSessionLock({
      stateDir: cfg.stateDir,
      sessionId,
      action: async () => {
        let cleanerReserved = cleanerRequests.has(sessionId);
        if (executeCleaner) {
          cleanerRequests.delete(sessionId);
          cleanerReserved = false;
        }
        try {
          const pending = await readOpenClawCleanerSchedule(cfg.stateDir, sessionId);
          cleanerReserved ||= pending?.status === "scheduled";
          if (!executeCleaner && pending?.status === "scheduled"
            && await hasOpenClawCleanerApplyIntent(cfg.stateDir, pending.cleanPlanId)) {
            return preserveCanonical(sessionId, runtimeMessages);
          }
          if (executeCleaner && pending?.status === "scheduled") {
            const result = await applyScheduledOpenClawCleanUnlocked({
              stateDir: cfg.stateDir, sessionId,
              replacementMode: cfg.eviction?.replacementMode === "drop" ? "drop" : "pointer_stub",
            });
            cleanerReserved ||= result.reserved;
          }
        } catch {
          // Preserve the Host request and reserve its history from automatic eviction.
          cleanerReserved = true;
          logger.warn?.("[context-cleaner] scheduled clean unavailable; preserving context");
          cleanerRequests.add(sessionId);
          // Keep the exact revision needed for intent recovery on the next request.
          return preserveCanonical(sessionId, runtimeMessages);
        }
        if (cleanerReserved) cleanerRequests.add(sessionId);
        return syncAndEvictLocked(sessionId, runtimeMessages, runtimeMessageIdPrefix, cleanerReserved);
      },
    }).catch((error) => {
      if ((error as Error).message !== "openclaw_clean_session_busy") throw error;
      return preserveCanonical(sessionId, runtimeMessages);
    });
  }

  async function syncAndEvictLocked(
    sessionId: string, runtimeMessages: any[], runtimeMessageIdPrefix: string, cleanerReserved: boolean,
  ) {
    const evictionConfig = cleanerReserved
      ? { ...cfg, moduleEnablement: { ...cfg.moduleEnablement, eviction: false } }
      : cfg;
    const context: {
      synced?: Awaited<ReturnType<typeof syncCanonicalStateFromTranscript>>;
      eviction?: Awaited<ReturnType<typeof runHistoryEvictionIfEnabled>>;
    } = {};
    let transcriptAvailable = false;
    const historyModuleExecutions = await runHistoryModules({
      context,
      modules: [
        {
          id: TOKENPILOT_HISTORY_MODULE_IDS.canonicalSync,
          enabled: () => true,
          run: async () => {
            context.synced = await syncCanonicalStateFromTranscript({
              stateDir: cfg.stateDir,
              sessionId,
              getMessage: (entry: any) => entry.message,
              helpers: {
                appendTaskStateTrace: deps.appendTaskStateTrace,
                readTranscriptEntriesForSession: async (currentSessionId: string) => {
                  const entries = await deps.readTranscriptEntriesForSession(currentSessionId);
                  transcriptAvailable = entries !== null;
                  return entries;
                },
                stableIdForEntry: deps.transcriptMessageStableId,
              },
            });
            // OpenClaw may supply a runtime-scoped session id that has no
            // matching on-disk transcript filename. The Context Engine already
            // receives the effective messages, so use them as the canonical
            // input fallback instead of returning a non-persisted empty state.
            if (!transcriptAvailable && runtimeMessages.length > 0) {
              const runtimeEntries = runtimeMessages.map((message, index) => {
                const record = message && typeof message === "object"
                  ? message as Record<string, unknown>
                  : { role: "unknown", content: String(message ?? "") };
                const nativeId = [record.id, record.messageId, record.message_id]
                  .find((value) => typeof value === "string" && value.trim().length > 0);
                const row: {
                  id?: string;
                  timestamp?: string;
                  message: Record<string, unknown>;
                } = {
                  ...(nativeId ? { id: String(nativeId) } : {}),
                  timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
                  message: record,
                };
                return {
                  ...row,
                  id: row.id
                    ?? `${runtimeMessageIdPrefix}:${index}:${deps.transcriptMessageStableId(row)}`,
                };
              });
              const appended = appendCanonicalTranscript(
                context.synced.state,
                runtimeEntries,
                sessionId,
                (entry) => entry.message,
                (entry) => deps.transcriptMessageStableId(entry),
              );
              context.synced = {
                state: appended.state,
                changed: context.synced.changed || appended.changed,
              };
            }
            return context.synced;
          },
        },
        {
          id: TOKENPILOT_HISTORY_MODULE_IDS.eviction,
          enabled: () => evictionConfig.moduleEnablement.eviction,
          run: async () => {
            context.eviction = await runHistoryEvictionIfEnabled({
              cfg: evictionConfig,
              sessionId,
              state: context.synced!.state,
              helpers: {
                ...deps,
                canonicalMessageTaskIds: canonicalMessageTaskIdsBound,
              },
              logger,
              rewriteCanonicalState,
              estimateMessagesChars,
            });
            await deps.appendTaskStateTrace(cfg.stateDir, {
              stage: "history_eviction_completed",
              sessionId,
              changed: context.eviction.changed,
              appliedTaskIds: context.eviction.appliedTaskIds,
              savedChars: context.eviction.savedChars,
              diagnostics: context.eviction.diagnostics,
            });
            return context.eviction;
          },
        },
        {
          id: TOKENPILOT_HISTORY_MODULE_IDS.memoryConsumer,
          enabled: () => Boolean(context.eviction?.appliedTaskIds.length),
          run: async () => enqueueEvictedTasksForProceduralMemory({
            cfg,
            sessionId,
            state: context.eviction!.state,
            appliedTaskIds: context.eviction!.appliedTaskIds,
            helpers: deps,
            logger,
          }),
        },
        {
          id: TOKENPILOT_HISTORY_MODULE_IDS.canonicalPersistence,
          enabled: () => Boolean(context.synced?.changed || context.eviction?.changed),
          run: async () => saveCanonicalState(
            cfg.stateDir,
            context.eviction?.state ?? context.synced!.state,
          ),
        },
      ],
    });
    const synced = context.synced!;
    const eviction = context.eviction ?? await runHistoryEvictionIfEnabled({
      cfg: evictionConfig,
      sessionId,
      state: synced.state,
      helpers: {
        ...deps,
        canonicalMessageTaskIds: canonicalMessageTaskIdsBound,
      },
      logger,
      rewriteCanonicalState,
      estimateMessagesChars,
    });
    try {
      await appendModuleObservation(cfg.stateDir, {
        sessionId,
        phase: "history",
        moduleId: "eviction",
        enabled: eviction.enabled,
        executed: historyModuleExecutions.some(
          (execution) => execution.id === "eviction" && execution.status === "executed",
        ),
        changed: eviction.changed,
        skippedReason: eviction.diagnostics.skippedReason,
        savedChars: eviction.savedChars,
        savedTokens: Math.max(0, Math.round(eviction.savedChars / 4)),
        api: { inputTokens: 0, outputTokens: 0 },
      });
    } catch (error) {
      logger.warn?.(
        `[context-engine] module observation write failed module=eviction: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      state: eviction.state,
      changed: synced.changed || eviction.changed,
      synced,
      eviction,
      historyModuleExecutions,
    };
  }

  async function reserveTurnCommit(params: {
    advancementKey: string;
    sessionId: string;
    messages: any[];
  }): Promise<boolean> {
    const safeSessionId = params.sessionId.replace(/[^a-zA-Z0-9._-]+/g, "_") || "session";
    const keyHash = createHash("sha256").update(params.advancementKey).digest("hex");
    const path = join(
      cfg.stateDir,
      "tokenpilot",
      "context-engine-turns",
      safeSessionId,
      `${keyHash}.json`,
    );
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, JSON.stringify({
        version: 1,
        advancementKey: params.advancementKey,
        sessionId: params.sessionId,
        messages: params.messages,
        committedAt: new Date().toISOString(),
      }), { encoding: "utf8", flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  return {
    info: {
      id: "tokenpilot",
      name: "Layered Context Engine",
      transcriptSemantics: {
        currentTurnFence: "before-current-turn-entry-v1",
        turnAdvancementIdempotency: "atomic-idempotent-v1",
      },
    },
    async ingest() {
      return { ingested: false };
    },
    async afterTurn(params: { sessionId: string; messages: any[] }) {
      // Accepted turns are durably advanced by commitTurn. afterTurn only
      // reconciles host transcript state and runs post-turn modules.
      await syncAndEvict(params.sessionId);
    },
    async commitTurn(params: {
      advancementKey: string;
      sessionId: string;
      messages: any[];
    }) {
      const committed = await reserveTurnCommit(params);
      const keyHash = createHash("sha256").update(params.advancementKey).digest("hex");
      // Always reconcile the canonical mirror, including on a host retry. If a
      // process stopped after the durable marker was written, the retry repairs
      // the mirror while still reporting the advancement as a duplicate.
      await syncAndEvict(params.sessionId, params.messages, `turn:${keyHash}`);
      return { status: committed ? "committed" as const : "duplicate" as const };
    },
    async assemble(params: { sessionId: string; messages: any[]; tokenBudget?: number }) {
      const result = await syncAndEvict(params.sessionId, params.messages, "runtime", true);
      const estimatedChars = estimateMessagesChars(result.state.messages, deps.contentToText);
      return {
        messages: result.state.messages,
        estimatedTokens: Math.max(1, Math.ceil(estimatedChars / 4)),
      };
    },
    async compact(params: { sessionId: string; messages?: any[]; force?: boolean }) {
      const result = await syncAndEvict(params.sessionId, params.messages ?? []);
      return {
        ok: true,
        compacted: result.changed,
        reason: result.changed
          ? "tokenpilot canonical state updated"
          : "tokenpilot canonical state unchanged",
      };
    },
  };
}
