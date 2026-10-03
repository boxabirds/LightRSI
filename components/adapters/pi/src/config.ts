import { dirname, join, resolve } from "node:path";
import {
  loadCanonicalAdapterConfig,
  normalizeCanonicalAdapterConfig,
  runtimeHomeDir,
  writeCanonicalAdapterConfig,
  type CanonicalAdapterConfig,
} from "../../shared/canonical/config.js";

export type TokenPilotPiConfig = CanonicalAdapterConfig;

/** pi's agent directory (`~/.pi/agent`, override `PI_CODING_AGENT_DIR`). */
export function defaultPiAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  return override ? resolve(override) : join(runtimeHomeDir(), ".pi", "agent");
}

export function defaultTokenPilotPiConfigPath(): string {
  return process.env.TOKENPILOT_PI_CONFIG
    ? resolve(process.env.TOKENPILOT_PI_CONFIG)
    : join(defaultPiAgentDir(), "tokenpilot.json");
}

export function defaultPiStateDir(configPath = defaultTokenPilotPiConfigPath()): string {
  return join(dirname(configPath), "tokenpilot-state", "tokenpilot");
}

/** Directory pi auto-loads user extensions from. */
export function defaultPiExtensionDir(): string {
  return join(defaultPiAgentDir(), "extensions", "tokenpilot");
}

export function normalizeTokenPilotPiConfig(raw: unknown, options?: { configPath?: string }): TokenPilotPiConfig {
  return normalizeCanonicalAdapterConfig(raw, {
    defaultStateDir: defaultPiStateDir(options?.configPath ?? defaultTokenPilotPiConfigPath()),
  });
}

export function loadTokenPilotPiConfig(configPath = defaultTokenPilotPiConfigPath()): Promise<TokenPilotPiConfig> {
  return loadCanonicalAdapterConfig(configPath, { defaultStateDir: defaultPiStateDir(configPath) });
}

export function writeTokenPilotPiConfig(config: TokenPilotPiConfig, configPath = defaultTokenPilotPiConfigPath()): Promise<void> {
  return writeCanonicalAdapterConfig(config, configPath);
}
