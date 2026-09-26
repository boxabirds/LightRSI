#!/usr/bin/env node
import {
  installCodexTokenPilot,
  type CodexInstallResult,
} from "../src/install.js";

export function formatProxyInstallStatus(
  daemon: CodexInstallResult["daemon"],
): string[] {
  return [
    `Proxy daemon: ${daemon.running ? "running" : "not running"}`,
    `Proxy health: ${daemon.running ? "ok" : "failed"}`,
    `Proxy log: ${daemon.logPath}`,
    "SessionStart hooks remain installed as an idempotent recovery path.",
  ];
}

async function main(): Promise<void> {
  const result = await installCodexTokenPilot({
    codexConfigPath: process.env.CODEX_CONFIG_PATH,
    tokenPilotConfigPath: process.env.TOKENPILOT_CODEX_CONFIG,
    hooksConfigPath: process.env.CODEX_HOOKS_CONFIG_PATH,
  });
  console.log(`Installed TokenPilot Codex routing on provider '${result.providerName}'`);
  console.log(`Codex config: ${result.codexConfigPath}`);
  console.log(`TokenPilot config: ${result.tokenPilotConfigPath}`);
  console.log(`Codex hooks config: ${result.hooksConfigPath} (${result.hooksInstalled ? "installed" : "skipped"})`);
  console.log(`Recovery MCP server: ${result.mcpServerName}`);
  console.log(`Recovery MCP startup timeout: ${result.expectedMcpStartupTimeoutSec}s`);
  console.log(`Command skills dir: ${result.commandSkillsDir}`);
  console.log(`Command skills: ${result.commandSkillNames.join(", ")}`);
  const callableCliPath = result.cliLauncherPath ?? result.cliBinPath;
  console.log(`lightrsi CLI bin: ${result.cliBinInstalled ? `installed at ${callableCliPath}` : `skipped (missing build at ${result.cliBinPath})`}`);
  if (!result.cliBinDirOnPath) {
    console.log(`lightrsi CLI PATH note: add ${result.cliBinDir} to PATH if 'lightrsi' is unavailable.`);
  }
  if (result.hostCliBinPath) {
    console.log(`tokenpilot-codex CLI bin: installed at ${result.hostCliLauncherPath ?? result.hostCliBinPath}`);
  }
  console.log(`Recovery MCP probe: ${result.mcpProbe.ok ? "ok" : "degraded"}`);
  console.log(`Recovery MCP probe detail: ${result.mcpProbe.detail}`);
  console.log(`Proxy base URL: ${result.baseUrl}`);
  for (const line of formatProxyInstallStatus(result.daemon)) console.log(line);
  console.log("Next step: trust the TokenPilot hooks if Codex asks for hook review.");
  console.log(`Codex default provider remains '${result.providerName}', and TokenPilot forwards upstream to '${result.activeProviderName}'.`);
  console.log("For manual troubleshooting, run: tokenpilot-codex start");
  console.log("If Codex reports hooks need review, run /hooks and trust the TokenPilot hooks.");
  if (result.mcpProbe.degraded) {
    console.log("MCP recovery is currently degraded. Core Codex runtime remains usable, but `memory_fault_recover` may be unavailable until MCP startup succeeds.");
  }
}

if (/install-codex\.(?:js|ts)$/u.test(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
