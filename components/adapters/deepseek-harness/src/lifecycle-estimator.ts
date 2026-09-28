/**
 * Shared task-state estimator wrapper (Task-R2, "调用共享 estimator，不复制算法").
 *
 * This is a thin adapter over `@lightrsi/eviction`'s estimator: it maps the
 * DSH adapter's config to the shared `TaskStateEstimatorApiConfig`, constructs
 * the shared estimator, and runs it over `{ registry, delta }`. It contains no
 * estimation logic of its own and does not touch the surface.
 *
 * The estimator OUTPUT (`SemanticTaskUpdate`) is owned by the shared package
 * and may evolve; this module treats it as opaque and never reads its internal
 * fields — downstream (R3 safety filter / R4 apply) consumes it.
 */

import {
  createConfiguredTaskStateEstimator,
  isTaskStateEstimatorConfigured,
  type TaskStateEstimator,
  type TaskStateEstimatorApiConfig,
  type TaskStateEstimatorInput,
  type TaskStateEstimatorOutput,
} from "@lightrsi/eviction";

import type { DshEstimatorConfig } from "./config.js";

/** True only when the estimator has the endpoint + credentials it needs to run. */
export function isEstimatorConfigured(cfg: DshEstimatorConfig): boolean {
  return isTaskStateEstimatorConfigured(cfg);
}

/** Map the DSH adapter config onto the shared estimator config (field-for-field). */
export function toEstimatorApiConfig(cfg: DshEstimatorConfig): TaskStateEstimatorApiConfig {
  return {
    enabled: cfg.enabled,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    requestTimeoutMs: cfg.requestTimeoutMs,
    batchTurns: cfg.batchTurns,
    evictionLookaheadTurns: cfg.evictionLookaheadTurns,
    inputMode: cfg.inputMode,
    lifecycleMode: cfg.lifecycleMode,
    evidenceMode: cfg.evidenceMode,
  };
}

/**
 * Construct the shared estimator, or return `undefined` when the estimator is
 * disabled or missing credentials. Returning `undefined` (rather than throwing)
 * lets the pre-step handler fail open and defer.
 */
export function createDshTaskStateEstimator(cfg: DshEstimatorConfig): TaskStateEstimator | undefined {
  return createConfiguredTaskStateEstimator(toEstimatorApiConfig(cfg));
}

/** Run the shared estimator over the codec-produced input. Output is opaque here. */
export async function runTaskStateEstimate(
  estimator: TaskStateEstimator,
  input: TaskStateEstimatorInput,
): Promise<TaskStateEstimatorOutput> {
  return await estimator.estimate(input);
}
