#!/usr/bin/env node

import { resolve } from "node:path";

import { installLightRsiCliBin } from "../../shared/cli-bin-install.js";

async function main(): Promise<void> {
  const adapterRoot = resolve(__dirname, "..");
  const result = await installLightRsiCliBin({ adapterRoot });
  if (!result.installed) {
    throw new Error(`Bundled lightrsi CLI not found at ${result.cliDistPath}`);
  }

  process.stdout.write(`Installed lightrsi CLI -> ${result.binPath}\n`);
  if (!result.binDirOnPath) {
    process.stdout.write(`Add ${result.binDir} to PATH before using lightrsi.\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
