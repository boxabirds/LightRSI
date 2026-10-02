/**
 * Shared task-state estimator wiring for canonical-surface eviction hosts.
 *
 * Lifted from the DeepSeek Harness adapter (`lifecycle-estimator.ts`). The
 * estimator is constructed only when it has an endpoint, credentials and a
 * model, so a missing setting defers eviction instead of failing a request.
 */

import { createApiTaskStateEstimator } from "../task-state-estimator.js";
import type { TaskStateEstimator, TaskStateEstimatorApiConfig } from "../types.js";

/** True only when the estimator has the endpoint + credentials it needs to run. */
export function isTaskStateEstimatorConfigured(cfg: Pick<TaskStateEstimatorApiConfig, "baseUrl" | "apiKey" | "model">): boolean {
  return Boolean(cfg.baseUrl && cfg.apiKey && cfg.model);
}

/**
 * Construct the shared estimator, or return `undefined` when it is disabled or
 * incompletely configured. Returning `undefined` lets hosts fail open.
 */
export function createConfiguredTaskStateEstimator(cfg: TaskStateEstimatorApiConfig): TaskStateEstimator | undefined {
  if (cfg.enabled === false) return undefined;
  if (!isTaskStateEstimatorConfigured(cfg)) return undefined;
  return createApiTaskStateEstimator(cfg);
}
