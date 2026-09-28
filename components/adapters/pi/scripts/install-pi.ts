#!/usr/bin/env node
import { installPiTokenPilot } from "../src/install.js";

async function main() {
  const result = await installPiTokenPilot({
    agentDir: process.env.PI_CODING_AGENT_DIR,
    configPath: process.env.TOKENPILOT_PI_CONFIG,
  });
  console.log([
    "TokenPilot pi install complete:",
    `- extension loader: ${result.paths.loaderPath}`,
    `- extension bundle: ${result.bundlePath}`,
    ...(result.backupPath ? [`- previous loader backed up to: ${result.backupPath}`] : []),
    `- tokenpilot config: ${result.paths.configPath} (${result.configCreated ? "created, normal mode" : "kept existing"})`,
    `- state dir: ${result.stateDir}`,
    `- install manifest: ${result.paths.manifestPath}`,
    result.cliBin?.installed
      ? `- lightrsi CLI bin: installed at ${result.cliBin.launcherPath ?? result.cliBin.binPath}`
      : `- lightrsi CLI bin: skipped (build components/products/cli first)`,
    ...(result.cliBin && !result.cliBin.binDirOnPath ? [`- lightrsi CLI PATH note: add ${result.cliBin.binDir} to PATH if 'lightrsi' is unavailable.`] : []),
    "- next step: start (or /reload) pi so the extension loads",
    "- verify: lightrsi pi doctor",
  ].join("\n"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
