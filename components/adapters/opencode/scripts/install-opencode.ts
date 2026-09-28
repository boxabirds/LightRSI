#!/usr/bin/env node
import { installOpenCodeTokenPilot } from "../src/install.js";

async function main() {
  const result = await installOpenCodeTokenPilot({
    configDir: process.env.TOKENPILOT_OPENCODE_CONFIG_DIR,
    tokenPilotConfigPath: process.env.TOKENPILOT_OPENCODE_CONFIG,
  });
  const lines = [
    "TokenPilot OpenCode install complete:",
    `- plugin loader: ${result.paths.loaderPath}`,
    `- plugin bundle: ${result.bundlePath}`,
    ...(result.loaderBackupPath ? [`- previous loader backed up to: ${result.loaderBackupPath}`] : []),
    `- tokenpilot config: ${result.paths.tokenPilotConfigPath} (${result.tokenPilotConfigCreated ? "created, normal mode" : "kept existing"})`,
    `- state dir: ${result.stateDir}`,
    `- recovery MCP: ${result.mcp.registered ? `${result.mcp.reason} in ${result.paths.opencodeJsonPath}` : `NOT registered (${result.mcp.reason})`}`,
    ...(result.mcp.backupPath ? [`- opencode.json backup: ${result.mcp.backupPath}`] : []),
    ...(!result.mcp.serverBuilt ? ["- recovery MCP server is not built yet: run `pnpm --filter @lightrsi/mcp build`"] : []),
    ...(!result.mcp.registered ? ["- add this to your OpenCode config manually:", result.mcp.snippet] : []),
    result.cliBin?.installed
      ? `- lightrsi CLI bin: installed at ${result.cliBin.launcherPath ?? result.cliBin.binPath}`
      : "- lightrsi CLI bin: skipped (build components/products/cli first)",
    ...(result.cliBin && !result.cliBin.binDirOnPath ? [`- lightrsi CLI PATH note: add ${result.cliBin.binDir} to PATH if 'lightrsi' is unavailable.`] : []),
    "- next step: restart OpenCode so the plugin and MCP server load",
    "- verify: lightrsi opencode doctor",
  ];
  console.log(lines.join("\n"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
