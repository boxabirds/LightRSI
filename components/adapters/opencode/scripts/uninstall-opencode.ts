#!/usr/bin/env node
import { uninstallOpenCodeTokenPilot } from "../src/install.js";

async function main() {
  const purge = process.argv.includes("--purge");
  const result = await uninstallOpenCodeTokenPilot({
    configDir: process.env.TOKENPILOT_OPENCODE_CONFIG_DIR,
    tokenPilotConfigPath: process.env.TOKENPILOT_OPENCODE_CONFIG,
    purge,
  });
  console.log([
    "TokenPilot OpenCode uninstall:",
    `- plugin loader removed: ${result.loaderRemoved ? "yes" : "no"}`,
    `- previous loader restored: ${result.loaderBackupRestored ? "yes" : "no"}`,
    ...(result.foreignLoaderKept ? ["- a non-TokenPilot plugin exists at the path and was left untouched"] : []),
    `- recovery MCP entry removed: ${result.mcpRemoved ? "yes" : "no"}`,
    ...(result.opencodeConfigRemoved ? ["- opencode.json created by install was removed (it held nothing else)"] : []),
    `- config removed: ${result.configRemoved ? "yes" : purge ? "no (not created by install)" : "no (pass --purge)"}`,
    `- state removed: ${result.stateRemoved ? "yes" : purge ? "no" : "no (pass --purge)"}`,
  ].join("\n"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
