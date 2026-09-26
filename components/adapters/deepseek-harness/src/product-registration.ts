/**
 * Public product metadata for DeepSeek Harness.
 *
 * The native DSH command obtains live sessions through Cordis. This module is
 * intentionally limited to discovery/configuration and re-exports the public
 * Cleaner capability factory, so a CLI product never reaches into DSH events
 * or a session surface directly.
 */

import { readFile } from "node:fs/promises";

import { readLatestUxEffect } from "@lightrsi/host-adapter";
import {
  createContextCleanerControlPlane,
  createContextCleanerControlService,
  type ContextCleanerControlService,
} from "@lightrsi/cleaner";
import { defineProductHostRegistration } from "@lightrsi/product-surface";

import { normalizeDshConfig } from "./config.js";
import { createDshPersistedCleanerCapabilities } from "./context-cleaner/capabilities.js";

export {
  createDshCleanerCapabilities,
  createDshPersistedCleanerCapabilities,
  type DshCleanerCapabilityParams,
} from "./context-cleaner/capabilities.js";

/**
 * Create the external-CLI control service without acquiring any DSH runtime
 * object. It reads only fresh metadata snapshots published by DSH into
 * `stateDir`; approval writes a schedule pointer and cannot rewrite context.
 */
export function createDshPersistedCleanerControlService(params: {
  stateDir: string;
  maxSnapshotAgeMs?: number;
  now?: () => string;
  snapshotNow?: () => number;
}): ContextCleanerControlService {
  const stateDir = params.stateDir.trim();
  if (!stateDir) throw new Error("dsh_clean_state_dir_missing");
  return createContextCleanerControlService({
    stateDir,
    capabilities: createDshPersistedCleanerCapabilities({
      stateDir,
      ...(params.maxSnapshotAgeMs === undefined ? {} : { maxSnapshotAgeMs: params.maxSnapshotAgeMs }),
      ...(params.snapshotNow === undefined ? {} : { now: params.snapshotNow }),
    }),
    controlPlane: createContextCleanerControlPlane({
      stateDir,
      ...(params.now === undefined ? {} : { now: params.now }),
    }),
    ...(params.now === undefined ? {} : { now: params.now }),
  });
}

/** Resolve only the LightRSI-owned state directory; never read a DSH session here. */
export function resolveDshStateDir(config: unknown): string | undefined {
  return normalizeDshConfig(config).stateDir;
}

async function loadConfiguredStateDir(productConfigPath?: string): Promise<string | undefined> {
  const environment = process.env.TOKENPILOT_DSH_STATE_DIR?.trim();
  if (environment) return environment;
  const path = productConfigPath?.trim();
  if (!path) return undefined;
  try {
    return resolveDshStateDir(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

export const DSH_PRODUCT_HOST_REGISTRATION = defineProductHostRegistration({
  hostId: "deepseek-harness",
  displayName: "DeepSeek Harness",
  preset: { presetId: "tokenpilot-dsh", presetVersion: "1" },
  resolveStateDir(context) {
    return loadConfiguredStateDir(context?.productConfigPath);
  },
  readLatestActivity: readLatestUxEffect,
});
