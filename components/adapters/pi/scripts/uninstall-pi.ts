#!/usr/bin/env node
import { uninstallPiTokenPilot } from "../src/install.js";

async function main() {
  const purge = process.argv.includes("--purge");
  const result = await uninstallPiTokenPilot({
    agentDir: process.env.PI_CODING_AGENT_DIR,
    configPath: process.env.TOKENPILOT_PI_CONFIG,
    purge,
  });
  console.log([
    "TokenPilot pi uninstall:",
    `- loader removed: ${result.loaderRemoved ? "yes" : "no"}`,
    `- previous loader restored: ${result.backupRestored ? "yes" : "no"}`,
    ...(result.foreignLoaderKept ? ["- a non-TokenPilot loader exists at the path and was left untouched"] : []),
    `- config removed: ${result.configRemoved ? "yes" : purge ? "no (not created by install)" : "no (pass --purge)"}`,
    `- state removed: ${result.stateRemoved ? "yes" : purge ? "no" : "no (pass --purge)"}`,
  ].join("\n"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
