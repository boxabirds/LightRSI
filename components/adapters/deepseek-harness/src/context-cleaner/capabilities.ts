/**
 * Frozen one-way DSH Cleaner capabilities.
 *
 * DSH session/event shapes stay here. The shared Cleaner layer receives only
 * a canonical snapshot, a session catalogue, and durable pointer operations.
 */

import type {
  CleanerHostCapabilities,
  ContextCleanerScheduleRequest,
} from "@lightrsi/cleaner";
import type { SessionTaskRegistry } from "@lightrsi/history";

import { listDshCleanerSessions, type DshCleanerSessionStore } from "./session-catalog.js";
import {
  finalizeDshCleanerSchedule,
  scheduleDshCleanerPlan,
} from "./scheduler.js";
import {
  listDshCleanerSnapshots,
  readDshCleanerSnapshot,
} from "./persisted-snapshot.js";
import { buildDshCleanSnapshot, DSH_HOST_ID, surfaceRevision } from "./snapshot.js";

export type DshCleanerCapabilityParams = {
  stateDir: string;
  sessions: DshCleanerSessionStore;
  loadRegistry(sessionId: string): Promise<SessionTaskRegistry> | SessionTaskRegistry;
};

function validScheduleRequest(request: ContextCleanerScheduleRequest): boolean {
  return request.sessionId.trim().length > 0
    && request.cleanPlanId.trim().length > 0
    && request.baseRevision.trim().length > 0
    && request.selectedTaskIds.length > 0
    && new Set(request.selectedTaskIds).size === request.selectedTaskIds.length
    && request.selectedTaskIds.every((taskId) => taskId.trim().length > 0);
}

function createDshScheduleWriter(stateDir: string): CleanerHostCapabilities["scheduleWriter"] {
  return {
    async writeSchedule(request) {
      if (!validScheduleRequest(request)) {
        return {
          outcome: "bypassed" as const,
          reasons: ["dsh_cleaner_schedule_input_invalid"],
        };
      }
      return scheduleDshCleanerPlan({
        stateDir,
        sessionId: request.sessionId,
        cleanPlanId: request.cleanPlanId,
        baseRevision: request.baseRevision,
        selectedTaskIds: [...request.selectedTaskIds],
        scheduledAt: request.scheduledAt,
      });
    },
    abortSchedule(request) {
      return finalizeDshCleanerSchedule({
        stateDir,
        sessionId: request.sessionId,
        cleanPlanId: request.cleanPlanId,
        receiptStatus: request.receiptStatus,
        reasons: [...request.reasons],
        updatedAt: request.updatedAt,
      });
    },
  };
}

/**
 * External callers have no live DSH session object to revalidate against.
 * Require the last Host-published snapshot to remain fresh and to describe
 * exactly the revision being scheduled. The running Host revalidates again at
 * pre-step, but this prevents a stopped/expired external process from even
 * creating a new pointer from stale metadata.
 */
function createDshPersistedScheduleWriter(params: {
  stateDir: string;
  maxSnapshotAgeMs?: number;
  now?: () => number;
}): CleanerHostCapabilities["scheduleWriter"] {
  const writer = createDshScheduleWriter(params.stateDir);
  return {
    async writeSchedule(request) {
      const snapshot = await readDshCleanerSnapshot({
        stateDir: params.stateDir,
        sessionId: request.sessionId,
        ...(params.maxSnapshotAgeMs === undefined ? {} : { maxAgeMs: params.maxSnapshotAgeMs }),
        ...(params.now === undefined ? {} : { now: params.now }),
      });
      if (snapshot.outcome !== "ready") {
        return { outcome: "bypassed", reasons: [...snapshot.reasons] };
      }
      if (snapshot.snapshot.revision !== request.baseRevision) {
        return { outcome: "bypassed", reasons: ["dsh_clean_snapshot_revision_mismatch"] };
      }
      return writer.writeSchedule(request);
    },
    abortSchedule(request) {
      // Cancellation is safe (and desirable) even if DSH has stopped since
      // scheduling, so it must not require a live/fresh snapshot.
      return writer.abortSchedule(request);
    },
  };
}

/** Create the DeepSeek Harness implementation of the frozen Cleaner boundary. */
export function createDshCleanerCapabilities(
  params: DshCleanerCapabilityParams,
): CleanerHostCapabilities {
  const stateDir = params.stateDir.trim();
  if (!stateDir) throw new Error("dsh_clean_state_dir_missing");

  return {
    hostId: DSH_HOST_ID,
    rewriteMode: "canonical",
    snapshotSource: {
      hostId: DSH_HOST_ID,
      rewriteMode: "canonical",
      async readCleanSnapshot(sessionId) {
        const session = params.sessions.get(sessionId);
        if (!session) throw new Error("dsh_clean_snapshot_unavailable");
        const registry = await params.loadRegistry(sessionId);
        return buildDshCleanSnapshot({
          session,
          registry,
          revision: surfaceRevision(session),
        }).snapshot;
      },
    },
    sessionCatalog: {
      async listSessions() {
        return listDshCleanerSessions(params.sessions);
      },
    },
    scheduleWriter: createDshScheduleWriter(stateDir),
  };
}

/**
 * Public, stateDir-only capabilities for the shared CLI.
 *
 * Unlike `createDshCleanerCapabilities`, this factory has no Cordis session,
 * DSH event, or surface reference.  Its snapshots have to be published by the
 * running DSH adapter first; external callers can therefore analyse and write
 * a schedule, but never mutate live context themselves.
 */
export function createDshPersistedCleanerCapabilities(params: {
  stateDir: string;
  maxSnapshotAgeMs?: number;
  now?: () => number;
}): CleanerHostCapabilities {
  const stateDir = params.stateDir.trim();
  if (!stateDir) throw new Error("dsh_clean_state_dir_missing");

  return {
    hostId: DSH_HOST_ID,
    rewriteMode: "canonical",
    snapshotSource: {
      hostId: DSH_HOST_ID,
      rewriteMode: "canonical",
      async readCleanSnapshot(sessionId) {
        const snapshot = await readDshCleanerSnapshot({
          stateDir,
          sessionId,
          ...(params.maxSnapshotAgeMs === undefined ? {} : { maxAgeMs: params.maxSnapshotAgeMs }),
          ...(params.now === undefined ? {} : { now: params.now }),
        });
        if (snapshot.outcome !== "ready") {
          throw new Error(`dsh_clean_snapshot_unavailable:${snapshot.reasons.join(",")}`);
        }
        return snapshot.snapshot;
      },
    },
    sessionCatalog: {
      listSessions: () => listDshCleanerSnapshots({
        stateDir,
        ...(params.maxSnapshotAgeMs === undefined ? {} : { maxAgeMs: params.maxSnapshotAgeMs }),
        ...(params.now === undefined ? {} : { now: params.now }),
      }),
    },
    scheduleWriter: createDshPersistedScheduleWriter({
      stateDir,
      ...(params.maxSnapshotAgeMs === undefined ? {} : { maxSnapshotAgeMs: params.maxSnapshotAgeMs }),
      ...(params.now === undefined ? {} : { now: params.now }),
    }),
  };
}
