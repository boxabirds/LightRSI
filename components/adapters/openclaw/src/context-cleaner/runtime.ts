import { createHash } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  createContextCleanerHostExecutionBridge,
  readContextCleanReceipt,
  type ContextCleanReceipt,
  type ContextCleanScheduledReceipt,
} from "@lightrsi/cleaner";
import { loadSessionTaskRegistry, canonicalStatePath, type CanonicalTranscriptState } from "@lightrsi/history";
import { writeJsonFileAtomic } from "@lightrsi/host-adapter";
import { createOpenClawReferenceBackend } from "../context-rewrite/reference-backend.js";
import { dedupeStrings } from "../context-stack/integration/runtime-tooling.js";
import {
  createOpenClawCleanerRewriteRequest as createRequest,
  createOpenClawCleanerSnapshotSource,
  readOpenClawCleanerState,
} from "./snapshot.js";
import { readOpenClawCleanerSchedule, finishOpenClawCleanSchedule } from "./scheduler.js";
import { withOpenClawCleanerSessionLock } from "./session-lock.js";
const OPENCLAW_HOST_ID = "openclaw";

type OpenClawApplyIntent = {
  version: 1;
  planId: string;
  sessionId: string;
  previousRevision: string;
  nextRevision: string;
  receipt: ContextCleanReceipt;
};

function intentPath(stateDir: string, planId: string): string {
  const key = createHash("sha256").update(planId).digest("hex");
  return join(stateDir, "context-cleaner", "openclaw-apply", `${key}.json`);
}

async function readIntent(stateDir: string, planId: string): Promise<OpenClawApplyIntent | undefined> {
  try {
    const parsed = JSON.parse(await readFile(intentPath(stateDir, planId), "utf8")) as OpenClawApplyIntent;
    if (parsed?.version !== 1
      || parsed.planId !== planId
      || typeof parsed.sessionId !== "string"
      || typeof parsed.previousRevision !== "string"
      || typeof parsed.nextRevision !== "string"
      || !parsed.receipt
      || parsed.receipt.planId !== planId
      || parsed.receipt.status !== "applied") {
      throw new Error("openclaw_clean_apply_intent_invalid");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function saveIntent(stateDir: string, intent: OpenClawApplyIntent): Promise<void> {
  const path = intentPath(stateDir, intent.planId);
  await mkdir(dirname(path), { recursive: true });
  await writeJsonFileAtomic(path, intent);
}

async function removeIntent(stateDir: string, planId: string): Promise<void> {
  await unlink(intentPath(stateDir, planId)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function canonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isScheduledReceipt(
  receipt: ContextCleanReceipt,
): receipt is ContextCleanScheduledReceipt {
  return receipt.status === "scheduled";
}

function uniqueStrings(values: readonly string[]): string[] | undefined {
  const normalized = values.map((value) => value.trim());
  return normalized.every(Boolean) && new Set(normalized).size === normalized.length
    ? normalized
    : undefined;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const expected = [...left].sort();
  const actual = [...right].sort();
  return expected.length === actual.length
    && expected.every((value, index) => value === actual[index]);
}

function validNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validateReceipt(params: {
  receipt: ContextCleanReceipt;
  planId: string;
  sessionId?: string;
  selectedTaskIds?: string[];
}): ContextCleanReceipt {
  const { receipt } = params;
  if (receipt.schemaVersion !== CONTEXT_CLEAN_SCHEMA_VERSION
    || receipt.hostId !== OPENCLAW_HOST_ID
    || receipt.planId !== params.planId
    || (params.sessionId !== undefined && receipt.sessionId !== params.sessionId)
    || !canonicalTimestamp(receipt.updatedAt)
    || !uniqueStrings(receipt.selectedTaskIds)
    || !uniqueStrings(receipt.deferredTaskIds)
    || (receipt.estimatedSavedTokens !== null
      && !validNonNegativeInteger(receipt.estimatedSavedTokens))
    || !validNonNegativeInteger(receipt.estimatedSavedChars)) {
    throw new Error("openclaw_clean_receipt_mismatch");
  }
  if (params.selectedTaskIds
    && !sameStrings(receipt.selectedTaskIds, params.selectedTaskIds)) {
    throw new Error("openclaw_clean_receipt_mismatch");
  }
  if (receipt.status === "applied") {
    if (receipt.fallbackUsed
      || (receipt.appliedSavedTokens !== null
        && !validNonNegativeInteger(receipt.appliedSavedTokens))
      || !validNonNegativeInteger(receipt.appliedSavedChars)
      || !receipt.evidence.previousRevision.trim()
      || !receipt.evidence.nextRevision.trim()
      || !uniqueStrings(receipt.evidence.operationIds)?.length
      || !uniqueStrings(receipt.evidence.itemIds)?.length) {
      throw new Error("openclaw_clean_receipt_mismatch");
    }
  } else {
    const record = receipt as unknown as Record<string, unknown>;
    if (Object.hasOwn(record, "appliedSavedTokens")
      || Object.hasOwn(record, "appliedSavedChars")) {
      throw new Error("openclaw_clean_receipt_mismatch");
    }
  }
  return receipt;
}

function terminalReceipt(params: {
  scheduled: ContextCleanScheduledReceipt;
  status: "stale" | "failed";
  reasons: string[];
  now: () => string;
}): ContextCleanReceipt {
  return {
    ...params.scheduled,
    status: params.status,
    reasons: params.reasons.length > 0 ? params.reasons : [`openclaw_clean_${params.status}`],
    updatedAt: params.now(),
  };
}

function targetItemIds(params: {
  operationIds: readonly string[];
  mutationPlan: { operations: Array<{ id: string; targetItemIds: string[] }> };
}): string[] {
  const applied = new Set(params.operationIds);
  return dedupeStrings(params.mutationPlan.operations
    .filter((operation) => applied.has(operation.id))
    .flatMap((operation) => operation.targetItemIds));
}


export async function hasOpenClawCleanerApplyIntent(stateDir: string, planId: string): Promise<boolean> {
  return (await readIntent(stateDir, planId)) !== undefined;
}

/** Must run under the same session lock as native/CLI approve and cancel. */
export async function applyScheduledOpenClawCleanUnlocked(params: {
  stateDir: string;
  sessionId: string;
  replacementMode: "pointer_stub" | "drop";
  now?: () => string;
}): Promise<{ reserved: boolean; receipt?: ContextCleanReceipt }> {
  const request = await readOpenClawCleanerSchedule(params.stateDir, params.sessionId);
  if (!request || request.status === "terminal") return { reserved: false };
  const now = params.now ?? (() => new Date().toISOString());
  const replacementMode = params.replacementMode;
  const backend = createOpenClawReferenceBackend();
  const readState = (sessionId: string): Promise<CanonicalTranscriptState> =>
    readOpenClawCleanerState(params.stateDir, sessionId);
  const { readCleanSnapshot: readSnapshot } = createOpenClawCleanerSnapshotSource(params);
  const executionBridge = createContextCleanerHostExecutionBridge({
    stateDir: params.stateDir,
    hostId: OPENCLAW_HOST_ID,
    async readExecutionSnapshot(sessionId) {
      const [snapshot, registry] = await Promise.all([
        readSnapshot(sessionId),
        loadSessionTaskRegistry(params.stateDir, sessionId),
      ]);
      return {
        snapshot,
        activeTaskIds: registry.activeTaskIds,
        evictableTaskIds: registry.evictableTaskIds,
      };
    },
  });

  async function record(receipt: ContextCleanReceipt): Promise<ContextCleanReceipt> {
    const stored = await executionBridge.recordCleanReceipt(receipt);
    if (stored.bypassed) {
      throw new Error(`openclaw_clean_receipt_store_failed:${stored.reasons.join(",")}`);
    }
    return receipt;
  }

  async function recoverIntent(
    scheduled: ContextCleanScheduledReceipt,
  ): Promise<ContextCleanReceipt | undefined> {
    const intent = await readIntent(params.stateDir, scheduled.planId);
    if (!intent) return undefined;
    if (intent.sessionId !== scheduled.sessionId) {
      throw new Error("openclaw_clean_apply_intent_identity_mismatch");
    }
    validateReceipt({ receipt: intent.receipt, planId: scheduled.planId,
      sessionId: scheduled.sessionId, selectedTaskIds: scheduled.selectedTaskIds });
    if (intent.receipt.status !== "applied"
      || intent.receipt.evidence.previousRevision !== intent.previousRevision
      || intent.receipt.evidence.nextRevision !== intent.nextRevision) {
      throw new Error("openclaw_clean_apply_intent_evidence_mismatch");
    }
    const state = await readState(scheduled.sessionId);
    const current = await backend.readSnapshot({
      sessionId: scheduled.sessionId,
      request: createRequest({ stateDir: params.stateDir, state, replacementMode }),
    });
    if (current.revision === intent.nextRevision) {
      const receipt = await record(intent.receipt);
      await removeIntent(params.stateDir, scheduled.planId);
      return receipt;
    }
    if (current.revision === intent.previousRevision) {
      await removeIntent(params.stateDir, scheduled.planId);
      return undefined;
    }
    await removeIntent(params.stateDir, scheduled.planId);
    return record(terminalReceipt({
      scheduled,
      status: "stale",
      reasons: ["openclaw_clean_revision_stale"],
      now,
    }));
  }


  const current = await readContextCleanReceipt({ stateDir: params.stateDir, planId: request.cleanPlanId });
  if (current.bypassed || !current.value) throw new Error("openclaw_clean_receipt_unavailable");
  const scheduled = validateReceipt({ receipt: current.value, planId: request.cleanPlanId,
    sessionId: request.sessionId, selectedTaskIds: request.selectedTaskIds });
  if (scheduled.status === "approved" || scheduled.status === "analyzed") return { reserved: true };
  async function finish(receipt: ContextCleanReceipt) {
    const result = await finishOpenClawCleanSchedule(params.stateDir, request!, receipt.updatedAt);
    if (result.outcome !== "transitioned" && result.outcome !== "unchanged")
      throw new Error("openclaw_clean_schedule_finalize_failed");
    return { reserved: true, receipt };
  }
  if (!isScheduledReceipt(scheduled)) {
    if (scheduled.status === "applied") await removeIntent(params.stateDir, scheduled.planId);
    return finish(scheduled);
  }
  const recovered = await recoverIntent(scheduled);
  if (recovered) return finish(recovered);
  const selectedTaskIds = request.selectedTaskIds;
  const execute = async (): Promise<ContextCleanReceipt> => {
    const prepared = await executionBridge.prepareScheduledClean({
      cleanPlanId: request.cleanPlanId,
      sessionId: request.sessionId,
      baseRevision: request.baseRevision,
      selectedTaskIds,
    });
    if (prepared.outcome === "terminal") return prepared.receipt;
    if (prepared.outcome !== "ready") {
      const stale = prepared.reasons.some((reason) =>
        reason.includes("stale") || reason.includes("revision") || reason.includes("state_changed"));
      return record(terminalReceipt({
        scheduled,
        status: stale ? "stale" : "failed",
        reasons: prepared.reasons,
        now,
      }));
    }

    const state = await readState(request.sessionId);
    const backendRequest = createRequest({ stateDir: params.stateDir, state, replacementMode });
    const snapshot = await backend.readSnapshot({ sessionId: request.sessionId, request: backendRequest });
    if (snapshot.revision !== prepared.execution.baseRevision) {
      return record(terminalReceipt({
        scheduled,
        status: "stale",
        reasons: ["openclaw_clean_revision_stale"],
        now,
      }));
    }

    const applied = await backend.apply({
      snapshot,
      plan: prepared.execution.mutationPlan,
      request: backendRequest,
    }).catch(() => undefined);
    if (!applied) return record(terminalReceipt({
      scheduled, status: "failed", reasons: ["openclaw_clean_canonical_rewrite_failed"], now,
    }));
    if (!applied.result.applied || !applied.result.changed) {
      return record(terminalReceipt({
        scheduled,
        status: applied.result.fallbackUsed ? "failed" : "stale",
        reasons: applied.result.fallbackUsed
          ? ["openclaw_clean_canonical_rewrite_failed"]
          : ["openclaw_clean_no_applicable_targets"],
        now,
      }));
    }

    const appliedTaskIds = applied.result.details?.appliedTaskIds ?? [];
    const deferredTaskIds = selectedTaskIds.filter((taskId) => !appliedTaskIds.includes(taskId));
    const receipt: ContextCleanReceipt = {
      ...scheduled,
      status: "applied",
      appliedSavedTokens: null,
      appliedSavedChars: applied.result.savedChars,
      deferredTaskIds,
      reasons: deferredTaskIds.length > 0 ? ["openclaw_clean_targets_deferred"] : [],
      updatedAt: now(),
      fallbackUsed: false,
      evidence: {
        previousRevision: applied.result.previousRevision,
        nextRevision: applied.result.nextRevision,
        operationIds: [...applied.result.appliedOperationIds],
        itemIds: targetItemIds({
          operationIds: applied.result.appliedOperationIds,
          mutationPlan: prepared.execution.mutationPlan,
        }),
      },
    };
    await saveIntent(params.stateDir, {
      version: 1,
      planId: scheduled.planId,
      sessionId: scheduled.sessionId,
      previousRevision: applied.result.previousRevision,
      nextRevision: applied.result.nextRevision,
      receipt,
    });

    const latest = await readState(request.sessionId);
    const latestSnapshot = await backend.readSnapshot({
      sessionId: request.sessionId,
      request: createRequest({ stateDir: params.stateDir, state: latest, replacementMode }),
    });
    if (latestSnapshot.revision !== prepared.execution.baseRevision) {
      await removeIntent(params.stateDir, scheduled.planId);
      return record(terminalReceipt({
        scheduled,
        status: "stale",
        reasons: ["openclaw_clean_revision_stale"],
        now,
      }));
    }

    await writeJsonFileAtomic(
      canonicalStatePath(params.stateDir, request.sessionId),
      applied.request.state,
    );
    const storedReceipt = await record(receipt);
    await removeIntent(params.stateDir, scheduled.planId);
    return storedReceipt;
  };
  return finish(await execute());
}

export function applyScheduledOpenClawClean(params: {
  stateDir: string; sessionId: string; replacementMode: "pointer_stub" | "drop"; now?: () => string;
}) {
  return withOpenClawCleanerSessionLock({ ...params, action: () => applyScheduledOpenClawCleanUnlocked(params) });
}
