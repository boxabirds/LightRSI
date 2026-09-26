import type { CleanerHostCapabilities } from "@lightrsi/cleaner";
import { createOpenClawCleanerSnapshotSource } from "./snapshot.js";
import { listOpenClawCleanerSessions } from "./session-catalog.js";
import { finishOpenClawCleanSchedule, scheduleOpenClawClean } from "./scheduler.js";

export function createOpenClawCleanerCapabilities(params: {
  stateDir: string;
  replacementMode: "pointer_stub" | "drop";
}): CleanerHostCapabilities {
  return {
    hostId: "openclaw",
    rewriteMode: "canonical",
    snapshotSource: createOpenClawCleanerSnapshotSource(params),
    sessionCatalog: { listSessions: () => listOpenClawCleanerSessions(params.stateDir) },
    scheduleWriter: {
      writeSchedule: (request) => scheduleOpenClawClean(params.stateDir, request),
      abortSchedule: (request) => finishOpenClawCleanSchedule(params.stateDir, request, request.updatedAt),
    },
  };
}
