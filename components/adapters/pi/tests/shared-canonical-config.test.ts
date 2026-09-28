/**
 * Regression matrix: adapters/shared/canonical/config.ts
 *
 * normalizeCanonicalAdapterConfig
 *   G1 empty object → exact documented defaults (normal mode, eviction off)
 *   G2 non-object input (null, array, string, number) → same defaults
 *   G3 booleans: wrong type → default; right type → used
 *   G4 numbers: below min → min; above max → max; non-finite → default;
 *      numeric string accepted; fractional truncated
 *   G5 strings trimmed; blank → undefined
 *   G6 stateDir: "~/x" expanded against $HOME; absent → host default
 *   G7 dynamicContextTarget: "user" → user; anything else → developer
 *   G8 logLevel: "debug" → debug; anything else → info
 *   G9 passOptions: only known pass names with non-empty objects are kept
 *   G10 estimator enums: each valid value kept; invalid → undefined
 * load / write
 *   L1 missing file → defaults (with host default stateDir)
 *   L2 existing file → normalized contents
 *   L3 malformed JSON → throws (callers decide how to fail open)
 *   W1 write → atomic, mode 0600, round-trips through load
 * evaluateEvictionReadiness (checks in this order)
 *   R1 host binding lacks eviction          → unsupported_on_host
 *   R2 modules.eviction off                 → module_disabled
 *   R3 eviction.enabled off                 → eviction_disabled
 *   R4 taskStateEstimator.enabled === false → estimator_disabled
 *   R5 any of baseUrl/model/apiKey missing  → estimator_incomplete (+ missing list)
 *   R6 everything set                       → ready, active
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateEvictionReadiness,
  loadCanonicalAdapterConfig,
  normalizeCanonicalAdapterConfig,
  writeCanonicalAdapterConfig,
  type CanonicalAdapterConfig,
} from "../../shared/canonical/config.js";

const DEFAULT_STATE = "/state/default";
const norm = (raw: unknown) => normalizeCanonicalAdapterConfig(raw, { defaultStateDir: DEFAULT_STATE });

const DEFAULTS: CanonicalAdapterConfig = {
  enabled: true,
  logLevel: "info",
  stateDir: DEFAULT_STATE,
  hooks: { dynamicContextTarget: "developer" },
  modules: { stabilizer: true, reduction: true, eviction: false },
  eviction: { enabled: false, minBlockChars: 4000, failureMode: "bypass" },
  reduction: {
    triggerMinChars: 2200,
    maxToolChars: 1200,
    stableArchiveHints: true,
    passes: {
      readStateCompaction: true,
      toolPayloadTrim: true,
      htmlSlimming: true,
      execOutputTruncation: true,
      agentsStartupOptimization: true,
    },
    passOptions: {},
  },
  taskStateEstimator: {
    enabled: undefined,
    baseUrl: undefined,
    apiKey: undefined,
    model: undefined,
    requestTimeoutMs: 60_000,
    batchTurns: 5,
    evictionLookaheadTurns: 3,
    inputMode: undefined,
    lifecycleMode: undefined,
    evidenceMode: undefined,
  },
};

describe("normalizeCanonicalAdapterConfig", () => {
  it("G1 an empty object yields the documented defaults", () => {
    assert.deepEqual(norm({}), DEFAULTS);
  });
  it("G2 non-object input yields the same defaults", () => {
    for (const raw of [null, undefined, [], "x", 3]) assert.deepEqual(norm(raw), DEFAULTS, String(raw));
  });
  it("G3 booleans of the wrong type fall back; booleans are used", () => {
    assert.equal(norm({ enabled: "false" }).enabled, true);
    assert.equal(norm({ enabled: false }).enabled, false);
    assert.equal(norm({ modules: { eviction: 1 } }).modules.eviction, false);
    assert.equal(norm({ modules: { eviction: true } }).modules.eviction, true);
    assert.equal(norm({ reduction: { stableArchiveHints: false } }).reduction.stableArchiveHints, false);
  });
  it("G4 numbers are clamped, parsed and truncated", () => {
    assert.equal(norm({ reduction: { triggerMinChars: 1 } }).reduction.triggerMinChars, 256);
    assert.equal(norm({ reduction: { triggerMinChars: 9e9 } }).reduction.triggerMinChars, 1_000_000);
    assert.equal(norm({ reduction: { triggerMinChars: "abc" } }).reduction.triggerMinChars, 2200);
    assert.equal(norm({ reduction: { triggerMinChars: "3000" } }).reduction.triggerMinChars, 3000);
    assert.equal(norm({ reduction: { maxToolChars: 1500.9 } }).reduction.maxToolChars, 1500);
    assert.equal(norm({ eviction: { minBlockChars: 10 } }).eviction.minBlockChars, 256);
    assert.equal(norm({ taskStateEstimator: { requestTimeoutMs: 1 } }).taskStateEstimator.requestTimeoutMs, 1000);
  });
  it("G5 strings are trimmed and blanks become undefined", () => {
    const cfg = norm({ taskStateEstimator: { baseUrl: "  http://x  ", apiKey: "   ", model: "m" } });
    assert.equal(cfg.taskStateEstimator.baseUrl, "http://x");
    assert.equal(cfg.taskStateEstimator.apiKey, undefined);
  });
  it("G6 stateDir expands ~ and defaults to the host directory", () => {
    const previous = process.env.HOME;
    process.env.HOME = "/home/tester";
    try {
      assert.equal(norm({ stateDir: "~/tp" }).stateDir, "/home/tester/tp");
      assert.equal(norm({ stateDir: "~" }).stateDir, "/home/tester");
    } finally {
      process.env.HOME = previous;
    }
    assert.equal(norm({ stateDir: "  " }).stateDir, DEFAULT_STATE);
  });
  it("G7 dynamicContextTarget accepts user and defaults to developer", () => {
    assert.equal(norm({ hooks: { dynamicContextTarget: "user" } }).hooks.dynamicContextTarget, "user");
    assert.equal(norm({ hooks: { dynamicContextTarget: "system" } }).hooks.dynamicContextTarget, "developer");
  });
  it("G8 logLevel accepts debug and defaults to info", () => {
    assert.equal(norm({ logLevel: "debug" }).logLevel, "debug");
    assert.equal(norm({ logLevel: "trace" }).logLevel, "info");
  });
  it("G9 passOptions keep only known passes with non-empty objects", () => {
    const cfg = norm({
      reduction: {
        passOptions: {
          toolPayloadTrim: { maxChars: 10 },
          htmlSlimming: {},
          bogusPass: { a: 1 },
          execOutputTruncation: "x",
        },
      },
    });
    assert.deepEqual(cfg.reduction.passOptions, { toolPayloadTrim: { maxChars: 10 } });
  });
  it("G10 estimator enums keep valid values and drop invalid ones", () => {
    for (const inputMode of ["sliding_window", "completed_summary_plus_active_turns"] as const) {
      assert.equal(norm({ taskStateEstimator: { inputMode } }).taskStateEstimator.inputMode, inputMode);
    }
    for (const lifecycleMode of ["coupled", "decoupled"] as const) {
      assert.equal(norm({ taskStateEstimator: { lifecycleMode } }).taskStateEstimator.lifecycleMode, lifecycleMode);
    }
    for (const evidenceMode of ["two_state", "three_state"] as const) {
      assert.equal(norm({ taskStateEstimator: { evidenceMode } }).taskStateEstimator.evidenceMode, evidenceMode);
    }
    const bad = norm({ taskStateEstimator: { inputMode: "x", lifecycleMode: "x", evidenceMode: "x" } }).taskStateEstimator;
    assert.deepEqual([bad.inputMode, bad.lifecycleMode, bad.evidenceMode], [undefined, undefined, undefined]);
  });
});

describe("load and write", () => {
  it("L1 a missing file yields defaults with the host state dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-cfg-"));
    assert.deepEqual(await loadCanonicalAdapterConfig(join(dir, "none.json"), { defaultStateDir: DEFAULT_STATE }), DEFAULTS);
  });
  it("L2 an existing file is normalized", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-cfg-"));
    const path = join(dir, "tokenpilot.json");
    await writeFile(path, JSON.stringify({ reduction: { maxToolChars: 1800 } }));
    const cfg = await loadCanonicalAdapterConfig(path, { defaultStateDir: DEFAULT_STATE });
    assert.equal(cfg.reduction.maxToolChars, 1800);
    assert.equal(cfg.reduction.triggerMinChars, 2200);
  });
  it("L3 malformed JSON throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-cfg-"));
    const path = join(dir, "tokenpilot.json");
    await writeFile(path, "{not json");
    await assert.rejects(loadCanonicalAdapterConfig(path, { defaultStateDir: DEFAULT_STATE }));
  });
  it("W1 write is atomic, private, and round-trips", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-cfg-"));
    const path = join(dir, "nested", "tokenpilot.json");
    const cfg = norm({ reduction: { maxToolChars: 1800 } });
    await writeCanonicalAdapterConfig(cfg, path);
    assert.deepEqual(await loadCanonicalAdapterConfig(path, { defaultStateDir: DEFAULT_STATE }), cfg);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.ok((await readFile(path, "utf8")).endsWith("}\n"));
  });
});

describe("evaluateEvictionReadiness", () => {
  const ready = () => norm({
    modules: { eviction: true },
    eviction: { enabled: true },
    taskStateEstimator: { baseUrl: "http://x", model: "m", apiKey: "k" },
  });
  it("R1 an unsupported host is never active, even when fully configured", () => {
    assert.deepEqual(evaluateEvictionReadiness(ready(), false), { active: false, reason: "unsupported_on_host", missing: [] });
  });
  it("R2 modules.eviction off", () => {
    const cfg = ready();
    cfg.modules.eviction = false;
    assert.equal(evaluateEvictionReadiness(cfg, true).reason, "module_disabled");
  });
  it("R3 eviction.enabled off", () => {
    const cfg = ready();
    cfg.eviction.enabled = false;
    assert.equal(evaluateEvictionReadiness(cfg, true).reason, "eviction_disabled");
  });
  it("R4 estimator explicitly disabled", () => {
    const cfg = ready();
    cfg.taskStateEstimator.enabled = false;
    assert.equal(evaluateEvictionReadiness(cfg, true).reason, "estimator_disabled");
  });
  it("R5 each missing estimator field is reported", () => {
    for (const key of ["baseUrl", "model", "apiKey"] as const) {
      const cfg = ready();
      cfg.taskStateEstimator[key] = undefined;
      assert.deepEqual(evaluateEvictionReadiness(cfg, true), { active: false, reason: "estimator_incomplete", missing: [key] });
    }
  });
  it("R6 a complete configuration on a supporting host is active", () => {
    assert.deepEqual(evaluateEvictionReadiness(ready(), true), { active: true, reason: "ready", missing: [] });
  });
  it("defaults are inactive (eviction is opt-in)", () => {
    assert.equal(evaluateEvictionReadiness(DEFAULTS, true).active, false);
  });
});
