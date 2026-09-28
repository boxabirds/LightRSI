import {
  defaultTokenPilotPiConfigPath,
  loadTokenPilotPiConfig,
  normalizeTokenPilotPiConfig,
  writeTokenPilotPiConfig,
  type TokenPilotPiConfig,
} from "../../../../adapters/pi/src/config.js";
import { formatPiDoctorReport, inspectPiDoctor } from "../../../../adapters/pi/src/doctor.js";
import { piProductSurfaceConfigAdapter, resolvePiStateDir } from "../../../../adapters/pi/src/host-config-adapter.js";
import type { CliHostPathOverrides } from "../context-store.js";
import { createInProcessCliBridge, type InProcessHostSpec } from "./in-process.js";

export const PI_CLI_HOST_SPEC: InProcessHostSpec = {
  hostId: "pi",
  displayName: "pi",
  defaultConfigPath: defaultTokenPilotPiConfigPath,
  loadConfig: async (configPath) => (await loadTokenPilotPiConfig(configPath)) as unknown as Record<string, unknown>,
  normalizeConfig: (raw, configPath) => normalizeTokenPilotPiConfig(raw, { configPath }) as unknown as Record<string, unknown>,
  writeConfig: (config, configPath) => writeTokenPilotPiConfig(config as unknown as TokenPilotPiConfig, configPath),
  configAdapter: piProductSurfaceConfigAdapter,
  resolveStateDir: resolvePiStateDir,
  async doctor({ config, configPath }) {
    const report = await inspectPiDoctor({ config: config as unknown as TokenPilotPiConfig, configPath });
    return formatPiDoctorReport(report);
  },
};

export function createPiCliBridge(target: { host: "pi"; sessionId?: string; pathOverrides?: CliHostPathOverrides }) {
  return createInProcessCliBridge(PI_CLI_HOST_SPEC, target);
}
