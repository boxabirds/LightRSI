#!/usr/bin/env node
import { defaultTokenPilotPiConfigPath, loadTokenPilotPiConfig } from "../src/config.js";
import { formatPiDoctorReport, inspectPiDoctor } from "../src/doctor.js";

async function main() {
  const configPath = process.env.TOKENPILOT_PI_CONFIG ?? defaultTokenPilotPiConfigPath();
  const config = await loadTokenPilotPiConfig(configPath);
  const report = await inspectPiDoctor({ config, configPath, agentDir: process.env.PI_CODING_AGENT_DIR });
  console.log(formatPiDoctorReport(report));
  if (!report.healthy) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
