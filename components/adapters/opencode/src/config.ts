import { dirname, join, resolve } from "node:path";
import {
  loadCanonicalAdapterConfig,
  normalizeCanonicalAdapterConfig,
  runtimeHomeDir,
  writeCanonicalAdapterConfig,
  type CanonicalAdapterConfig,
} from "../../shared/canonical/config.js";

export type TokenPilotOpenCodeConfig = CanonicalAdapterConfig;

/**
 * OpenCode's global config dir: `$XDG_CONFIG_HOME/opencode`, default `~/.config/opencode`
 * (core `global.ts`). `TOKENPILOT_OPENCODE_CONFIG_DIR` overrides it for tests/custom installs.
 */
export function defaultOpenCodeConfigDir(): string {
  const override = process.env.TOKENPILOT_OPENCODE_CONFIG_DIR?.trim();
  if (override) return resolve(override);
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return join(xdg ? resolve(xdg) : join(runtimeHomeDir(), ".config"), "opencode");
}

export function defaultTokenPilotOpenCodeConfigPath(): string {
  return process.env.TOKENPILOT_OPENCODE_CONFIG
    ? resolve(process.env.TOKENPILOT_OPENCODE_CONFIG)
    : join(defaultOpenCodeConfigDir(), "tokenpilot.json");
}

export function defaultOpenCodeStateDir(configPath = defaultTokenPilotOpenCodeConfigPath()): string {
  return join(dirname(configPath), "tokenpilot-state", "tokenpilot");
}

export function normalizeTokenPilotOpenCodeConfig(raw: unknown, options?: { configPath?: string }): TokenPilotOpenCodeConfig {
  return normalizeCanonicalAdapterConfig(raw, {
    defaultStateDir: defaultOpenCodeStateDir(options?.configPath ?? defaultTokenPilotOpenCodeConfigPath()),
  });
}

export function loadTokenPilotOpenCodeConfig(configPath = defaultTokenPilotOpenCodeConfigPath()): Promise<TokenPilotOpenCodeConfig> {
  return loadCanonicalAdapterConfig(configPath, { defaultStateDir: defaultOpenCodeStateDir(configPath) });
}

export function writeTokenPilotOpenCodeConfig(
  config: TokenPilotOpenCodeConfig,
  configPath = defaultTokenPilotOpenCodeConfigPath(),
): Promise<void> {
  return writeCanonicalAdapterConfig(config, configPath);
}
