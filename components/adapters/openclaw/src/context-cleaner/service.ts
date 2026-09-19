import {
  createContextCleanerControlPlane,
  createContextCleanerControlService,
  type ContextCleanRecommendationProvider,
  type ContextCleanerControlService,
} from "@lightrsi/cleaner";
import { createOpenClawCleanerCapabilities } from "./capabilities.js";
import { hasOpenClawCleanerApplyIntent } from "./runtime.js";
import { finishOpenClawCleanSchedule, readOpenClawCleanerSchedule } from "./scheduler.js";
import { withOpenClawCleanerSessionLock } from "./session-lock.js";

/** Both command surfaces share the Host lock; shared Cleaner still owns all state transitions. */
export function createOpenClawCleanerControlService(params: {
  stateDir: string;
  replacementMode: "pointer_stub" | "drop";
  recommendationProvider?: ContextCleanRecommendationProvider;
  beforeAnalyze?: (sessionId: string) => Promise<void>;
  now?: () => string;
}): ContextCleanerControlService {
  const service = createContextCleanerControlService({
    stateDir: params.stateDir,
    capabilities: createOpenClawCleanerCapabilities(params),
    controlPlane: createContextCleanerControlPlane(params),
    recommendationProvider: params.recommendationProvider,
    now: params.now,
  });
  async function finishTerminalPointer(sessionId: string) {
    const pointer = await readOpenClawCleanerSchedule(params.stateDir, sessionId);
    if (!pointer || pointer.status === "terminal") return;
    if (await hasOpenClawCleanerApplyIntent(params.stateDir, pointer.cleanPlanId)) {
      throw new Error("openclaw_clean_recovery_required");
    }
    const receipt = await service.readReceipt(pointer.cleanPlanId);
    if (!receipt || ["analyzed", "approved", "scheduled"].includes(receipt.status)) return;
    const result = await finishOpenClawCleanSchedule(params.stateDir, pointer, receipt.updatedAt);
    if (result.outcome !== "transitioned" && result.outcome !== "unchanged") {
      throw new Error("openclaw_clean_schedule_finalize_failed");
    }
  }
  async function locked<T>(planId: string, action: () => Promise<T>): Promise<T> {
    const plan = await service.readPlan(planId);
    if (!plan) throw new Error("clean_plan_missing");
    return withOpenClawCleanerSessionLock({
      stateDir: params.stateDir, sessionId: plan.sessionId,
      action: async () => {
        // A crashed commit must be reconciled by the runtime, never overwritten by cancellation.
        if (await hasOpenClawCleanerApplyIntent(params.stateDir, planId)) {
          throw new Error("openclaw_clean_recovery_required");
        }
        await finishTerminalPointer(plan.sessionId);
        const result = await action();
        await finishTerminalPointer(plan.sessionId);
        return result;
      },
    });
  }
  return {
    ...service,
    analyze: (sessionId) => withOpenClawCleanerSessionLock({
      stateDir: params.stateDir, sessionId,
      action: async () => {
        await params.beforeAnalyze?.(sessionId);
        return service.analyze(sessionId);
      },
    }),
    approve: (planId, taskIds) => locked(planId, () => service.approve(planId, taskIds)),
    cancel: (planId) => locked(planId, () => service.cancel(planId)),
  };
}
