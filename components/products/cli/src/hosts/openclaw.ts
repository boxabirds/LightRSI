import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ProductSurfaceConfigAdapter,
  ProductSurfaceHostBridge,
} from "@lightrsi/host-adapter";
import { handleVisual as handleSharedVisual } from "@lightrsi/product-surface";
import { readLatestUxEffect, readSessionUxAggregate } from "../../../../adapters/openclaw/src/context-stack/integration/ux-effects.js";
import {
  readRecentOpenClawCacheAuditRecordsForSession,
} from "../../../../adapters/openclaw/src/cache-audit.js";
import { resolveOpenClawConfigPath } from "../../../../adapters/openclaw/src/context-stack/integration/openclaw-paths.js";
import {
  openClawProductSurfaceConfigAdapter,
  pluginConfigRecord,
  resolveStateDir,
} from "../../../../adapters/openclaw/src/commands/tokenpilot/host-config-adapter.js";
import { formatOpenClawDoctorReport, inspectOpenClawDoctor } from "../../../../adapters/openclaw/src/commands/tokenpilot/openclaw-doctor.js";
import { normalizeConfig } from "../../../../adapters/openclaw/src/context-stack/integration/config-normalize.js";
import { createOpenClawCleanerControlService } from "../../../../adapters/openclaw/src/context-cleaner/index.js";
import { createApiContextCleanRecommendationProvider } from "@lightrsi/cleaner";
import { buildSessionReportResult, resolveConfiguredPreferredSessionId } from "./shared.js";
import {
  ensureDetachedVisualDaemon,
  resolveCliEntryPathFromHostModule,
  singleHostVisualLogPath,
  singleHostVisualMetaPath,
  singleHostVisualPidPath,
} from "./visual-daemon.js";
import type { CleanCommandBackend } from "../clean.js";
import { createCleanCommandBackendFromControlService } from "./cleaner.js";

function normalizeSessionId(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

async function loadConfig(): Promise<Record<string, unknown>> {
  const configPath = resolveOpenClawConfigPath();
  try {
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function createOpenClawCleanCommandBackend(): Promise<CleanCommandBackend | undefined> {
  const config = await loadConfig();
  const stateDir = resolveStateDir(config);
  if (!stateDir) return undefined;
  const normalized = normalizeConfig(pluginConfigRecord(config));
  return createCleanCommandBackendFromControlService(createOpenClawCleanerControlService({
    stateDir,
    replacementMode: normalized.eviction.replacementMode ?? "pointer_stub",
    recommendationProvider: normalized.taskStateEstimator.enabled ? createApiContextCleanRecommendationProvider({
      baseUrl: normalized.taskStateEstimator.baseUrl,
      apiKey: normalized.taskStateEstimator.apiKey,
      model: normalized.taskStateEstimator.model,
      requestTimeoutMs: normalized.taskStateEstimator.requestTimeoutMs,
    }) : undefined,
  }));
}

async function writeConfig(nextConfig: Record<string, unknown>): Promise<void> {
  const configPath = resolveOpenClawConfigPath();
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
}

/** OpenClaw has no environment channel for the live session yet. */
async function resolveCurrentSessionId(): Promise<string | undefined> {
  return undefined;
}

async function maybeResolveLatestSessionId(): Promise<string | undefined> {
  return resolveConfiguredPreferredSessionId({
    loadConfig,
    resolveStateDir,
    async resolveLatestSessionId() {
      return undefined;
    },
    readLatestUxEffect,
  });
}

async function ensureVisualServerForStateDir(stateDir: string): Promise<string> {
  await mkdir(stateDir, { recursive: true });
  return ensureDetachedVisualDaemon<{ url?: string; pid?: number; stateDir?: string }>({
    daemonArgs: [resolveCliEntryPathFromHostModule(__filename), "__visual_daemon_single", stateDir],
    metaPath: singleHostVisualMetaPath(stateDir),
    pidPath: singleHostVisualPidPath(stateDir),
    logPath: singleHostVisualLogPath(stateDir),
    expectedSignature: stateDir,
    readSignature(meta) {
      return meta?.stateDir;
    },
    readUrl(meta) {
      return meta?.url;
    },
    readPid(meta) {
      return meta?.pid;
    },
  });
}

export function createOpenClawCliBridge(target: {
  host: "openclaw";
  sessionId?: string;
}): {
  bridge: ProductSurfaceHostBridge;
  configAdapter: ProductSurfaceConfigAdapter;
  resolveCurrentSessionId(): Promise<string | undefined>;
  maybeResolveLatestSessionId(): Promise<string | undefined>;
  resolveSessionId(sessionId?: string): Promise<string | undefined>;
} {
  const bridge: ProductSurfaceHostBridge = {
    loadConfig,
    writeConfig,
    async handleDoctor(currentConfig) {
      return {
        text: formatOpenClawDoctorReport(inspectOpenClawDoctor(currentConfig)),
      };
    },
    async handleVisual(currentConfig) {
      const stateDir = resolveStateDir(currentConfig);
      const effectiveStateDir = stateDir ?? "";
      if (!effectiveStateDir) {
        return { text: "TokenPilot stateDir is not configured." };
      }
      await ensureVisualServerForStateDir(effectiveStateDir);
      return handleSharedVisual(currentConfig, resolveStateDir);
    },
    async handleReport(_ctx, currentConfig) {
      return buildSessionReportResult({
        currentConfig,
        explicitSessionId: target.sessionId,
        configAdapter: openClawProductSurfaceConfigAdapter,
        async resolveLatestSessionId() {
          return undefined;
        },
        readLatestUxEffect,
        readSessionAggregate: readSessionUxAggregate,
        async readRecentCacheAuditRecords(stateDir, sessionId) {
          return readRecentOpenClawCacheAuditRecordsForSession(stateDir, sessionId, 64);
        },
      });
    },
  };

  return {
    bridge,
    configAdapter: openClawProductSurfaceConfigAdapter,
    resolveCurrentSessionId,
    maybeResolveLatestSessionId,
    async resolveSessionId(sessionId?: string): Promise<string | undefined> {
      return normalizeSessionId(sessionId);
    },
  };
}
