/**
 * `lightrsi pi doctor` / `npm run doctor:pi`: verifies the install and runtime state.
 * Every check is local and read-only.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { readLatestUxEffect, resolveLatestSessionId } from "@lightrsi/host-adapter";
import { canonicalRecoveryProtocolText } from "../../shared/canonical/before-call.js";
import { evaluateEvictionReadiness, type EvictionReadiness } from "../../shared/canonical/config.js";
import { adapterLogPath } from "../../shared/canonical/logger.js";
import type { TokenPilotPiConfig } from "./config.js";
import { isTokenPilotPiLoader, resolvePiInstallPaths } from "./install.js";
import { PI_TOKENPILOT_HOST_BINDING, piSupportsEviction } from "./preset.js";

export type PiDoctorReport = {
  configPath: string;
  configExists: boolean;
  enabled: boolean;
  loaderPath: string;
  loaderInstalled: boolean;
  loaderBundlePath?: string;
  bundleExists: boolean;
  stateDir: string;
  stateDirWritable: boolean;
  declaredFeatures: readonly string[];
  stabilizer: boolean;
  dynamicContextTarget: string;
  reduction: boolean;
  recoveryTool: "native tool (pi has no MCP)";
  recoveryProtocolInjected: boolean;
  eviction: EvictionReadiness;
  piVersion?: string;
  latestSessionId?: string;
  latestActivityAt?: string;
  adapterLogExists: boolean;
  healthy: boolean;
  problems: string[];
};

/** The bundle path the installed loader requires (`require("<path>")`). */
export function loaderTarget(loaderPath: string): string | undefined {
  try {
    const literal = /require\(("(?:[^"\\]|\\.)*")\)/.exec(readFileSync(loaderPath, "utf8"))?.[1];
    return literal ? JSON.parse(literal) as string : undefined;
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

function detectPiVersion(): string | undefined {
  try {
    const out = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 5000 });
    const text = `${out.stdout ?? ""}`.trim();
    return out.status === 0 && text ? text.split("\n")[0] : undefined;
  } catch {
    return undefined;
  }
}

export async function inspectPiDoctor(params: {
  config: TokenPilotPiConfig;
  configPath: string;
  agentDir?: string;
  detectVersion?: boolean;
}): Promise<PiDoctorReport> {
  const paths = resolvePiInstallPaths({ agentDir: params.agentDir, configPath: params.configPath });
  const loaderInstalled = await isTokenPilotPiLoader(paths.loaderPath);
  const loaderBundlePath = loaderInstalled ? loaderTarget(paths.loaderPath) : undefined;
  const bundleExists = Boolean(loaderBundlePath && existsSync(loaderBundlePath));
  const stateDir = params.config.stateDir;
  const stateDirWritable = existsSync(stateDir) && writable(stateDir);
  const eviction = evaluateEvictionReadiness(params.config, piSupportsEviction());
  const latestSessionId = stateDir ? await resolveLatestSessionId(stateDir).catch(() => undefined) : undefined;
  const latest = stateDir ? await readLatestUxEffect(stateDir).catch(() => null) : null;

  const problems: string[] = [];
  const configExists = existsSync(params.configPath);
  if (!configExists) problems.push(`config missing: ${params.configPath} (run install:pi)`);
  if (!params.config.enabled) problems.push("adapter disabled in config (enabled=false)");
  if (!loaderInstalled) problems.push(`pi loader missing: ${paths.loaderPath} (run install:pi)`);
  if (loaderInstalled && !bundleExists) problems.push(`loader points to a missing bundle: ${loaderBundlePath ?? "(unparseable)"} (run build)`);
  if (!stateDirWritable) problems.push(`state dir not writable: ${stateDir}`);
  if (params.config.modules.eviction && !eviction.active) problems.push(`eviction requested but inactive: ${eviction.reason}${eviction.missing.length ? ` (missing ${eviction.missing.join(", ")})` : ""}`);

  return {
    configPath: params.configPath,
    configExists,
    enabled: params.config.enabled,
    loaderPath: paths.loaderPath,
    loaderInstalled,
    ...(loaderBundlePath ? { loaderBundlePath } : {}),
    bundleExists,
    stateDir,
    stateDirWritable,
    declaredFeatures: PI_TOKENPILOT_HOST_BINDING.supportedFeatures,
    stabilizer: params.config.modules.stabilizer,
    dynamicContextTarget: params.config.hooks.dynamicContextTarget,
    reduction: params.config.modules.reduction,
    recoveryTool: "native tool (pi has no MCP)",
    recoveryProtocolInjected: canonicalRecoveryProtocolText().length > 0,
    eviction,
    ...(params.detectVersion === false ? {} : { piVersion: detectPiVersion() }),
    ...(latestSessionId ? { latestSessionId } : {}),
    ...(typeof latest?.at === "string" ? { latestActivityAt: latest.at } : {}),
    adapterLogExists: existsSync(adapterLogPath(stateDir)),
    healthy: problems.length === 0,
    problems,
  };
}

const yesNo = (value: boolean) => (value ? "yes" : "no");

export function formatPiDoctorReport(report: PiDoctorReport): string {
  return [
    "TokenPilot pi doctor:",
    `- tokenpilot config: ${report.configPath} (${report.configExists ? "present" : "missing"})`,
    `- enabled: ${yesNo(report.enabled)}`,
    `- pi version: ${report.piVersion ?? "(pi not found on PATH)"}`,
    `- extension loader: ${report.loaderPath} (${report.loaderInstalled ? "installed" : "missing"})`,
    `- extension bundle: ${report.loaderBundlePath ?? "(unknown)"} (${report.bundleExists ? "present" : "missing"})`,
    `- stateDir: ${report.stateDir} (${report.stateDirWritable ? "writable" : "not writable"})`,
    `- declared features: ${report.declaredFeatures.join(", ")}`,
    `- stabilizer: ${yesNo(report.stabilizer)} (target ${report.dynamicContextTarget})`,
    `- reduction: ${yesNo(report.reduction)}`,
    `- recovery: ${report.recoveryTool}; protocol injected: ${yesNo(report.recoveryProtocolInjected)}`,
    `- eviction: ${report.eviction.active ? "active" : `inactive (${report.eviction.reason})`}`,
    `- latest session: ${report.latestSessionId ?? "(none yet — start a pi session)"}`,
    `- latest activity: ${report.latestActivityAt ?? "(none yet)"}`,
    `- adapter log: ${report.adapterLogExists ? adapterLogPath(report.stateDir) : "(none)"}`,
    `- healthy: ${yesNo(report.healthy)}`,
    ...report.problems.map((problem) => `- problem: ${problem}`),
  ].join("\n");
}
