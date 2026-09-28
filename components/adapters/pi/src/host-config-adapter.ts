import type { ProductSurfaceConfigAdapter } from "@lightrsi/host-adapter";

export function resolvePiStateDir(config: Record<string, unknown>): string | undefined {
  const stateDir = config.stateDir;
  return typeof stateDir === "string" && stateDir.trim().length > 0 ? stateDir.trim() : undefined;
}

/** pi's runtime config is flat, like Claude Code's `tokenpilot.json`. */
export const piProductSurfaceConfigAdapter: ProductSurfaceConfigAdapter = {
  pluginConfigRecord: (config) => config,
  pluginEntryRecord: (config) => config,
  ensurePluginConfig: (config) => config,
  ensurePluginEntry: (config) => config,
  resolveStateDir: resolvePiStateDir,
};
