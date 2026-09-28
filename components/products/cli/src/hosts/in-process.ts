/**
 * Shared CLI bridge for in-process canonical adapters (pi, OpenCode).
 *
 * Mirrors the Claude Code / Codex bridges: flat `tokenpilot.json`, the restricted
 * host command handler (status, report, doctor, visual, mode conservative|normal,
 * stabilizer, reduction, eviction), and the shared report/visual surfaces. Only the
 * per-host pieces (config paths, doctor, display name) are supplied by the host.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ProductSurfaceConfigAdapter,
  ProductSurfaceHostBridge,
  readLatestUxEffect,
  readUxSessionAggregate,
  resolveLatestSessionId,
} from "@lightrsi/host-adapter";
import { formatDisplayValue, formatOnOff, getNestedValue } from "@lightrsi/product-surface";
import type { CliHostPathOverrides } from "../context-store.js";
import {
  applyStandardRuntimeModeConfig,
  buildSessionReportResult,
  createRestrictedHostCommandHandler,
  resolveConfiguredPreferredSessionId,
  resolvePreferredSessionId,
} from "./shared.js";
import { handleStandaloneVisualCommandWithSelection } from "./visual.js";

export const IN_PROCESS_REDUCTION_PASS_NAMES = [
  "readStateCompaction",
  "toolPayloadTrim",
  "htmlSlimming",
  "execOutputTruncation",
  "agentsStartupOptimization",
] as const;

export type InProcessHostSpec = {
  hostId: "pi" | "opencode";
  displayName: string;
  defaultConfigPath(): string;
  loadConfig(configPath: string): Promise<Record<string, unknown>>;
  normalizeConfig(raw: Record<string, unknown>, configPath: string): Record<string, unknown>;
  writeConfig(config: Record<string, unknown>, configPath: string): Promise<void>;
  configAdapter: ProductSurfaceConfigAdapter;
  resolveStateDir(config: Record<string, unknown>): string | undefined;
  doctor(params: { config: Record<string, unknown>; configPath: string; hostConfigPath?: string }): Promise<string>;
  /** Extra status lines after the shared ones. */
  statusLines?(config: Record<string, unknown>): string[];
};

export function formatInProcessStatus(spec: InProcessHostSpec, config: Record<string, unknown>): string {
  const evictionOn = Boolean(getNestedValue(config, ["modules", "eviction"])) && Boolean(getNestedValue(config, ["eviction", "enabled"]));
  return [
    `TokenPilot ${spec.displayName} status:`,
    `- enabled: ${formatOnOff(config.enabled)}`,
    `- stabilizer: ${formatOnOff(getNestedValue(config, ["modules", "stabilizer"]))}`,
    `- dynamicContextTarget: ${formatDisplayValue(getNestedValue(config, ["hooks", "dynamicContextTarget"]))}`,
    `- reduction: ${formatOnOff(getNestedValue(config, ["modules", "reduction"]))}`,
    `- triggerMinChars: ${formatDisplayValue(getNestedValue(config, ["reduction", "triggerMinChars"]))}`,
    `- maxToolChars: ${formatDisplayValue(getNestedValue(config, ["reduction", "maxToolChars"]))}`,
    `- stableArchiveHints: ${formatOnOff(getNestedValue(config, ["reduction", "stableArchiveHints"]))}`,
    `- eviction: ${formatOnOff(evictionOn)}`,
    `- evictionMinBlockChars: ${formatDisplayValue(getNestedValue(config, ["eviction", "minBlockChars"]))}`,
    `- stateDir: ${formatDisplayValue(config.stateDir)}`,
    ...(spec.statusLines?.(config) ?? []),
  ].join("\n");
}

export function createInProcessCliBridge(spec: InProcessHostSpec, target: {
  sessionId?: string;
  pathOverrides?: CliHostPathOverrides;
}): {
  bridge: ProductSurfaceHostBridge;
  configAdapter: ProductSurfaceConfigAdapter;
  maybeResolveLatestSessionId(): Promise<string | undefined>;
  resolveSessionId(sessionId?: string): Promise<string | undefined>;
  handleCommand(ctx: { args: string; sessionId?: string }): Promise<{ text: string }>;
} {
  const configPath = target.pathOverrides?.tokenPilotConfigPath?.trim() || spec.defaultConfigPath();
  const hostConfigPath = target.pathOverrides?.hostConfigPath?.trim() || undefined;
  const loadConfig = () => spec.loadConfig(configPath);
  const writeConfig = async (next: Record<string, unknown>) => {
    await mkdir(dirname(configPath), { recursive: true });
    await spec.writeConfig(spec.normalizeConfig(next, configPath), configPath);
  };

  const bridge: ProductSurfaceHostBridge = {
    loadConfig,
    writeConfig,
    async handleDoctor(currentConfig) {
      return { text: await spec.doctor({ config: currentConfig, configPath, hostConfigPath }) };
    },
    async handleVisual(currentConfig) {
      const stateDir = spec.resolveStateDir(currentConfig);
      if (!stateDir) return { text: "TokenPilot stateDir is not configured." };
      const sessionId = await resolvePreferredSessionId({
        explicitSessionId: target.sessionId,
        stateDir,
        resolveLatestSessionId,
        readLatestUxEffect,
      });
      return handleStandaloneVisualCommandWithSelection({ host: spec.hostId, sessionId });
    },
    async handleReport(_ctx, currentConfig) {
      return buildSessionReportResult({
        currentConfig,
        explicitSessionId: target.sessionId,
        configAdapter: spec.configAdapter,
        resolveLatestSessionId,
        readLatestUxEffect,
        readSessionAggregate: readUxSessionAggregate,
      });
    },
  };

  const handleCommand = createRestrictedHostCommandHandler({
    displayName: spec.displayName,
    cliHostName: spec.hostId,
    reductionPassNames: IN_PROCESS_REDUCTION_PASS_NAMES,
    supportsEviction: true,
    bridge,
    configAdapter: spec.configAdapter,
    loadConfig,
    formatStatus: (config) => formatInProcessStatus(spec, config),
    async applyMode(mode) {
      await writeConfig(applyStandardRuntimeModeConfig(await loadConfig(), mode));
    },
  });

  return {
    bridge,
    configAdapter: spec.configAdapter,
    maybeResolveLatestSessionId() {
      return resolveConfiguredPreferredSessionId({
        loadConfig,
        resolveStateDir: spec.resolveStateDir,
        resolveLatestSessionId,
        readLatestUxEffect,
      });
    },
    async resolveSessionId(sessionId?: string) {
      const text = typeof sessionId === "string" ? sessionId.trim() : "";
      return text || undefined;
    },
    handleCommand,
  };
}
