import { dirname } from "node:path";
import {
  defaultTokenPilotOpenCodeConfigPath,
  loadTokenPilotOpenCodeConfig,
  normalizeTokenPilotOpenCodeConfig,
  writeTokenPilotOpenCodeConfig,
  type TokenPilotOpenCodeConfig,
} from "../../../../adapters/opencode/src/config.js";
import { formatOpenCodeDoctorReport, inspectOpenCodeDoctor } from "../../../../adapters/opencode/src/doctor.js";
import {
  openCodeProductSurfaceConfigAdapter,
  resolveOpenCodeStateDir,
} from "../../../../adapters/opencode/src/host-config-adapter.js";
import type { CliHostPathOverrides } from "../context-store.js";
import { createInProcessCliBridge, type InProcessHostSpec } from "./in-process.js";

export const OPENCODE_CLI_HOST_SPEC: InProcessHostSpec = {
  hostId: "opencode",
  displayName: "OpenCode",
  defaultConfigPath: defaultTokenPilotOpenCodeConfigPath,
  loadConfig: async (configPath) => (await loadTokenPilotOpenCodeConfig(configPath)) as unknown as Record<string, unknown>,
  normalizeConfig: (raw, configPath) => normalizeTokenPilotOpenCodeConfig(raw, { configPath }) as unknown as Record<string, unknown>,
  writeConfig: (config, configPath) => writeTokenPilotOpenCodeConfig(config as unknown as TokenPilotOpenCodeConfig, configPath),
  configAdapter: openCodeProductSurfaceConfigAdapter,
  resolveStateDir: resolveOpenCodeStateDir,
  async doctor({ config, configPath, hostConfigPath }) {
    const report = await inspectOpenCodeDoctor({
      config: config as unknown as TokenPilotOpenCodeConfig,
      configPath,
      ...(hostConfigPath ? { configDir: dirname(hostConfigPath) } : {}),
    });
    return formatOpenCodeDoctorReport(report);
  },
};

export function createOpenCodeCliBridge(target: { host: "opencode"; sessionId?: string; pathOverrides?: CliHostPathOverrides }) {
  return createInProcessCliBridge(OPENCODE_CLI_HOST_SPEC, target);
}
