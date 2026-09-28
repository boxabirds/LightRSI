/**
 * Runtime config shared by the in-process canonical-transcript adapters (pi,
 * OpenCode). Keys and defaults match the Claude Code adapter
 * (`claude-code/src/config.ts`) so the shared CLI (`mode`, `reduction`,
 * `stabilizer`, `eviction`) edits the same shape on every host. Host-specific
 * paths are supplied by each adapter.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CanonicalReductionPassName =
  | "readStateCompaction"
  | "toolPayloadTrim"
  | "htmlSlimming"
  | "execOutputTruncation"
  | "agentsStartupOptimization";

export const CANONICAL_REDUCTION_PASS_NAMES: readonly CanonicalReductionPassName[] = [
  "readStateCompaction",
  "toolPayloadTrim",
  "htmlSlimming",
  "execOutputTruncation",
  "agentsStartupOptimization",
];

export type CanonicalAdapterConfig = {
  enabled: boolean;
  logLevel: "info" | "debug";
  stateDir: string;
  hooks: {
    dynamicContextTarget: "developer" | "user";
  };
  modules: {
    stabilizer: boolean;
    reduction: boolean;
    eviction: boolean;
  };
  eviction: {
    enabled: boolean;
    minBlockChars: number;
    failureMode: "bypass";
  };
  reduction: {
    triggerMinChars: number;
    maxToolChars: number;
    /**
     * Reuse the first reduction text for a tool result when a later re-run only
     * changes the timestamped `Archive:` path line. See docs/adapters/pi-design.md.
     */
    stableArchiveHints: boolean;
    passes: Record<CanonicalReductionPassName, boolean>;
    passOptions: Record<string, Record<string, unknown>>;
  };
  taskStateEstimator: {
    enabled?: boolean;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    requestTimeoutMs: number;
    batchTurns: number;
    evictionLookaheadTurns: number;
    inputMode?: "sliding_window" | "completed_summary_plus_active_turns";
    lifecycleMode?: "coupled" | "decoupled";
    evidenceMode?: "two_state" | "three_state";
  };
};

export function runtimeHomeDir(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
}

export function expandHomePath(value: string): string {
  if (value === "~") return runtimeHomeDir();
  if (value.startsWith("~/")) return join(runtimeHomeDir(), value.slice(2));
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  const next = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(next)));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sanitizePassOptions(raw: unknown): Record<string, Record<string, unknown>> {
  const input = asRecord(raw);
  const output: Record<string, Record<string, unknown>> = {};
  for (const key of CANONICAL_REDUCTION_PASS_NAMES) {
    const value = asRecord(input[key]);
    if (Object.keys(value).length > 0) output[key] = value;
  }
  return output;
}

export function normalizeCanonicalAdapterConfig(
  raw: unknown,
  options: { defaultStateDir: string },
): CanonicalAdapterConfig {
  const obj = asRecord(raw);
  const hooks = asRecord(obj.hooks);
  const modules = asRecord(obj.modules);
  const eviction = asRecord(obj.eviction);
  const reduction = asRecord(obj.reduction);
  const passes = asRecord(reduction.passes);
  const estimator = asRecord(obj.taskStateEstimator);
  return {
    enabled: boolValue(obj.enabled, true),
    logLevel: obj.logLevel === "debug" ? "debug" : "info",
    stateDir: expandHomePath(stringValue(obj.stateDir) ?? options.defaultStateDir),
    hooks: {
      dynamicContextTarget: hooks.dynamicContextTarget === "user" ? "user" : "developer",
    },
    modules: {
      stabilizer: boolValue(modules.stabilizer, true),
      reduction: boolValue(modules.reduction, true),
      eviction: boolValue(modules.eviction, false),
    },
    eviction: {
      enabled: boolValue(eviction.enabled, false),
      minBlockChars: numberValue(eviction.minBlockChars, 4000, 256, 1_000_000),
      failureMode: "bypass",
    },
    reduction: {
      triggerMinChars: numberValue(reduction.triggerMinChars, 2200, 256, 1_000_000),
      maxToolChars: numberValue(reduction.maxToolChars, 1200, 256, 1_000_000),
      stableArchiveHints: boolValue(reduction.stableArchiveHints, true),
      passes: {
        readStateCompaction: boolValue(passes.readStateCompaction, true),
        toolPayloadTrim: boolValue(passes.toolPayloadTrim, true),
        htmlSlimming: boolValue(passes.htmlSlimming, true),
        execOutputTruncation: boolValue(passes.execOutputTruncation, true),
        agentsStartupOptimization: boolValue(passes.agentsStartupOptimization, true),
      },
      passOptions: sanitizePassOptions(reduction.passOptions),
    },
    taskStateEstimator: {
      enabled: typeof estimator.enabled === "boolean" ? estimator.enabled : undefined,
      baseUrl: stringValue(estimator.baseUrl),
      apiKey: stringValue(estimator.apiKey),
      model: stringValue(estimator.model),
      requestTimeoutMs: numberValue(estimator.requestTimeoutMs, 60_000, 1000, 600_000),
      batchTurns: numberValue(estimator.batchTurns, 5, 1, 1000),
      evictionLookaheadTurns: numberValue(estimator.evictionLookaheadTurns, 3, 1, 1000),
      inputMode: estimator.inputMode === "sliding_window"
        ? "sliding_window"
        : estimator.inputMode === "completed_summary_plus_active_turns"
          ? "completed_summary_plus_active_turns"
          : undefined,
      lifecycleMode: estimator.lifecycleMode === "decoupled"
        ? "decoupled"
        : estimator.lifecycleMode === "coupled" ? "coupled" : undefined,
      evidenceMode: estimator.evidenceMode === "two_state"
        ? "two_state"
        : estimator.evidenceMode === "three_state" ? "three_state" : undefined,
    },
  };
}

export async function loadCanonicalAdapterConfig(
  configPath: string,
  options: { defaultStateDir: string },
): Promise<CanonicalAdapterConfig> {
  if (!existsSync(configPath)) return normalizeCanonicalAdapterConfig({}, options);
  const text = await readFile(configPath, "utf8");
  return normalizeCanonicalAdapterConfig(JSON.parse(text), options);
}

export async function writeCanonicalAdapterConfig(config: CanonicalAdapterConfig, configPath: string): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, configPath);
}

export type EvictionReadiness = {
  /** True only when the host declares eviction and every setting is complete. */
  active: boolean;
  reason:
    | "ready"
    | "unsupported_on_host"
    | "module_disabled"
    | "eviction_disabled"
    | "estimator_disabled"
    | "estimator_incomplete";
  missing: string[];
};

/**
 * Eviction is opt-in. It runs only when the host binding declares it, both
 * `modules.eviction` and `eviction.enabled` are on, the estimator is not
 * explicitly disabled, and `taskStateEstimator.{baseUrl,model,apiKey}` are set.
 */
export function evaluateEvictionReadiness(
  config: CanonicalAdapterConfig,
  hostSupportsEviction: boolean,
): EvictionReadiness {
  const missing = (["baseUrl", "model", "apiKey"] as const).filter((key) => !config.taskStateEstimator[key]);
  if (!hostSupportsEviction) return { active: false, reason: "unsupported_on_host", missing };
  if (!config.modules.eviction) return { active: false, reason: "module_disabled", missing };
  if (!config.eviction.enabled) return { active: false, reason: "eviction_disabled", missing };
  if (config.taskStateEstimator.enabled === false) return { active: false, reason: "estimator_disabled", missing };
  if (missing.length > 0) return { active: false, reason: "estimator_incomplete", missing };
  return { active: true, reason: "ready", missing };
}
