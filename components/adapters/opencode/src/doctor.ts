/**
 * `lightrsi opencode doctor` / `npm run doctor:opencode`.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readLatestUxEffect, resolveLatestSessionId } from "@lightrsi/host-adapter";
import { probeTokenPilotMcpServer, type TokenPilotMcpProbeResult } from "@lightrsi/mcp";
import { canonicalRecoveryProtocolText } from "../../shared/canonical/before-call.js";
import { evaluateEvictionReadiness, type EvictionReadiness } from "../../shared/canonical/config.js";
import { adapterLogPath } from "../../shared/canonical/logger.js";
import type { TokenPilotOpenCodeConfig } from "./config.js";
import {
  OPENCODE_MCP_KEY,
  buildOpenCodeMcpEntry,
  isTokenPilotOpenCodeLoader,
  resolveOpenCodeInstallPaths,
  type OpenCodeMcpEntry,
} from "./install.js";
import { OPENCODE_TOKENPILOT_HOST_BINDING, openCodeSupportsEviction } from "./preset.js";

export type OpenCodeDoctorReport = {
  configPath: string;
  configExists: boolean;
  enabled: boolean;
  opencodeVersion?: string;
  loaderPath: string;
  loaderInstalled: boolean;
  loaderBundlePath?: string;
  bundleExists: boolean;
  opencodeConfigPath: string;
  opencodeConfigState: "json" | "jsonc_only" | "missing" | "unparseable";
  mcpRegistered: boolean;
  mcpMatchesExpected: boolean;
  mcpServerBuilt: boolean;
  mcpProbe?: TokenPilotMcpProbeResult;
  nativePrune: "on" | "off";
  stateDir: string;
  stateDirWritable: boolean;
  declaredFeatures: readonly string[];
  stabilizer: boolean;
  dynamicContextTarget: "developer" | "user";
  reduction: boolean;
  recoveryProtocolInjected: boolean;
  eviction: EvictionReadiness;
  latestSessionId?: string;
  latestActivityAt?: string;
  adapterLogExists: boolean;
  healthy: boolean;
  warnings: string[];
  problems: string[];
};

/** The bundle path the installed ESM loader re-exports. */
export function openCodeLoaderTarget(loaderPath: string): string | undefined {
  try {
    const literal = /from ("(?:[^"\\]|\\.)*");/.exec(readFileSync(loaderPath, "utf8"))?.[1];
    return literal ? fileURLToPath(JSON.parse(literal) as string) : undefined;
  } catch {
    return undefined;
  }
}

function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function detectOpenCodeVersion(): string | undefined {
  try {
    const out = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 10_000 });
    const text = `${out.stdout ?? ""}`.trim();
    return out.status === 0 && text ? text.split("\n")[0] : undefined;
  } catch {
    return undefined;
  }
}

function sameEntry(observed: unknown, expected: OpenCodeMcpEntry): boolean {
  if (!observed || typeof observed !== "object") return false;
  const o = observed as Record<string, unknown>;
  return o.type === "local"
    && Array.isArray(o.command)
    && JSON.stringify(o.command) === JSON.stringify(expected.command)
    && (o.environment as Record<string, unknown> | undefined)?.TOKENPILOT_STATE_DIR === expected.environment.TOKENPILOT_STATE_DIR
    && o.enabled !== false;
}

export async function inspectOpenCodeDoctor(params: {
  config: TokenPilotOpenCodeConfig;
  configPath: string;
  configDir?: string;
  detectVersion?: boolean;
  probeMcp?: boolean;
}): Promise<OpenCodeDoctorReport> {
  const paths = resolveOpenCodeInstallPaths({ configDir: params.configDir, tokenPilotConfigPath: params.configPath });
  const loaderInstalled = await isTokenPilotOpenCodeLoader(paths.loaderPath);
  const loaderBundlePath = loaderInstalled ? openCodeLoaderTarget(paths.loaderPath) : undefined;
  const bundleExists = Boolean(loaderBundlePath && existsSync(loaderBundlePath));

  let opencodeConfigState: OpenCodeDoctorReport["opencodeConfigState"] = "missing";
  let root: Record<string, unknown> | undefined;
  if (existsSync(paths.opencodeJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(paths.opencodeJsonPath, "utf8"));
      root = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
      opencodeConfigState = root ? "json" : "unparseable";
    } catch {
      opencodeConfigState = "unparseable";
    }
  } else if (existsSync(paths.opencodeJsoncPath)) {
    opencodeConfigState = "jsonc_only";
  }
  const expected = buildOpenCodeMcpEntry(params.config.stateDir);
  const observedEntry = (root?.mcp as Record<string, unknown> | undefined)?.[OPENCODE_MCP_KEY];
  const mcpRegistered = observedEntry !== undefined;
  const mcpMatchesExpected = sameEntry(observedEntry, expected.entry);
  const compaction = root?.compaction as Record<string, unknown> | undefined;
  const nativePrune = compaction?.prune === true && !process.env.OPENCODE_DISABLE_PRUNE ? "on" : "off";
  const mcpProbe = params.probeMcp === false || !expected.built
    ? undefined
    : await probeTokenPilotMcpServer({
      serverName: OPENCODE_MCP_KEY,
      command: expected.entry.command[0]!,
      args: expected.entry.command.slice(1),
      env: expected.entry.environment,
      entryPath: expected.entryPath,
    }, { timeoutMs: 15_000 });

  const stateDir = params.config.stateDir;
  const stateDirWritable = existsSync(stateDir) && writable(stateDir);
  const eviction = evaluateEvictionReadiness(params.config, openCodeSupportsEviction());
  const latestSessionId = await resolveLatestSessionId(stateDir).catch(() => undefined);
  const latest = await readLatestUxEffect(stateDir).catch(() => null);

  const problems: string[] = [];
  const warnings: string[] = [];
  const configExists = existsSync(params.configPath);
  if (!configExists) problems.push(`config missing: ${params.configPath} (run install:opencode)`);
  if (!params.config.enabled) problems.push("adapter disabled in config (enabled=false)");
  if (!loaderInstalled) problems.push(`plugin loader missing: ${paths.loaderPath} (run install:opencode)`);
  if (loaderInstalled && !bundleExists) problems.push(`loader points to a missing bundle: ${loaderBundlePath ?? "(unparseable)"} (run build)`);
  if (!mcpRegistered) {
    problems.push(opencodeConfigState === "jsonc_only"
      ? `recovery MCP not registered: only ${paths.opencodeJsoncPath} exists; paste the snippet printed by install:opencode`
      : `recovery MCP not registered in ${paths.opencodeJsonPath}`);
  } else if (!mcpMatchesExpected) {
    problems.push("recovery MCP entry does not match the expected command/state dir (re-run install:opencode)");
  }
  if (!expected.built) problems.push(`recovery MCP server not built: ${expected.entryPath} (pnpm --filter @lightrsi/mcp build)`);
  if (mcpProbe && !mcpProbe.ok) problems.push(`recovery MCP probe failed: ${mcpProbe.detail}`);
  if (!stateDirWritable) problems.push(`state dir not writable: ${stateDir}`);
  if (params.config.modules.eviction && !eviction.active) problems.push(`eviction requested but inactive: ${eviction.reason}${eviction.missing.length ? ` (missing ${eviction.missing.join(", ")})` : ""}`);
  if (params.config.hooks.dynamicContextTarget === "user") warnings.push("dynamicContextTarget=user is not supported on OpenCode; developer is used");
  if (nativePrune === "on") warnings.push("OpenCode native pruning (compaction.prune) is on: older tool outputs are cleared persistently by OpenCode");

  return {
    configPath: params.configPath,
    configExists,
    enabled: params.config.enabled,
    ...(params.detectVersion === false ? {} : { opencodeVersion: detectOpenCodeVersion() }),
    loaderPath: paths.loaderPath,
    loaderInstalled,
    ...(loaderBundlePath ? { loaderBundlePath } : {}),
    bundleExists,
    opencodeConfigPath: paths.opencodeJsonPath,
    opencodeConfigState,
    mcpRegistered,
    mcpMatchesExpected,
    mcpServerBuilt: expected.built,
    ...(mcpProbe ? { mcpProbe } : {}),
    nativePrune,
    stateDir,
    stateDirWritable,
    declaredFeatures: OPENCODE_TOKENPILOT_HOST_BINDING.supportedFeatures,
    stabilizer: params.config.modules.stabilizer,
    dynamicContextTarget: params.config.hooks.dynamicContextTarget,
    reduction: params.config.modules.reduction,
    recoveryProtocolInjected: canonicalRecoveryProtocolText().length > 0,
    eviction,
    ...(latestSessionId ? { latestSessionId } : {}),
    ...(typeof latest?.at === "string" ? { latestActivityAt: latest.at } : {}),
    adapterLogExists: existsSync(adapterLogPath(stateDir)),
    healthy: problems.length === 0,
    warnings,
    problems,
  };
}

const yesNo = (value: boolean) => (value ? "yes" : "no");

export function formatOpenCodeDoctorReport(report: OpenCodeDoctorReport): string {
  return [
    "TokenPilot OpenCode doctor:",
    `- tokenpilot config: ${report.configPath} (${report.configExists ? "present" : "missing"})`,
    `- enabled: ${yesNo(report.enabled)}`,
    `- opencode version: ${report.opencodeVersion ?? "(opencode not found on PATH)"}`,
    `- plugin loader: ${report.loaderPath} (${report.loaderInstalled ? "installed" : "missing"})`,
    `- plugin bundle: ${report.loaderBundlePath ?? "(unknown)"} (${report.bundleExists ? "present" : "missing"})`,
    `- opencode config: ${report.opencodeConfigPath} (${report.opencodeConfigState})`,
    `- recovery MCP registered: ${yesNo(report.mcpRegistered)} (matches expected: ${yesNo(report.mcpMatchesExpected)})`,
    `- recovery MCP server built: ${yesNo(report.mcpServerBuilt)}`,
    `- recovery MCP probe: ${report.mcpProbe ? (report.mcpProbe.ok ? "ok" : `failed (${report.mcpProbe.detail})`) : "(skipped)"}`,
    `- native tool-output pruning: ${report.nativePrune}`,
    `- stateDir: ${report.stateDir} (${report.stateDirWritable ? "writable" : "not writable"})`,
    `- declared features: ${report.declaredFeatures.join(", ")}`,
    `- stabilizer: ${yesNo(report.stabilizer)} (target ${report.dynamicContextTarget === "user" ? "user → developer (unsupported)" : "developer"})`,
    `- reduction: ${yesNo(report.reduction)}`,
    `- recovery protocol injected: ${yesNo(report.recoveryProtocolInjected)}`,
    `- eviction: ${report.eviction.active ? "active" : `inactive (${report.eviction.reason})`}`,
    `- latest session: ${report.latestSessionId ?? "(none yet — start an OpenCode session)"}`,
    `- latest activity: ${report.latestActivityAt ?? "(none yet)"}`,
    `- adapter log: ${report.adapterLogExists ? adapterLogPath(report.stateDir) : "(none)"}`,
    `- healthy: ${yesNo(report.healthy)}`,
    ...report.warnings.map((warning) => `- warning: ${warning}`),
    ...report.problems.map((problem) => `- problem: ${problem}`),
  ].join("\n");
}
