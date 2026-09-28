#!/usr/bin/env node
import { defaultTokenPilotOpenCodeConfigPath, loadTokenPilotOpenCodeConfig } from "../src/config.js";
import { formatOpenCodeDoctorReport, inspectOpenCodeDoctor } from "../src/doctor.js";

async function main() {
  const configPath = process.env.TOKENPILOT_OPENCODE_CONFIG ?? defaultTokenPilotOpenCodeConfigPath();
  const config = await loadTokenPilotOpenCodeConfig(configPath);
  const report = await inspectOpenCodeDoctor({ config, configPath, configDir: process.env.TOKENPILOT_OPENCODE_CONFIG_DIR });
  console.log(formatOpenCodeDoctorReport(report));
  if (!report.healthy) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
