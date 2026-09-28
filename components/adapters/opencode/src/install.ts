/**
 * Reversible install for the OpenCode adapter.
 *
 * install:
 *   1. writes a marker-tagged ESM loader `<config-dir>/plugins/tokenpilot.js` that
 *      re-exports the built `dist/plugin.mjs` (OpenCode auto-loads `plugins/*.js`);
 *      a foreign file at that path is moved to a timestamped backup first;
 *   2. registers the shared recovery MCP server as `mcp.tokenpilot_memory_fault_recover`
 *      in `<config-dir>/opencode.json` after writing a timestamped backup of the file.
 *      An `opencode.jsonc`-only setup (or unparseable JSON) is never rewritten: the
 *      snippet is returned for the user to paste;
 *   3. writes `<config-dir>/tokenpilot.json` in normal mode if missing (never credentials).
 * uninstall removes exactly what install added (loader, the one `mcp` key) and restores
 * the loader backup; `purge` also removes the created config and state.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveTokenPilotMcpServerSpec, TOKENPILOT_MCP_SERVER_NAME } from "@lightrsi/mcp";
import { installLightRsiCliBin } from "../../shared/cli-bin-install.js";
import { rememberCliHostPathOverrides } from "../../shared/cli-context.js";
import {
  defaultOpenCodeConfigDir,
  loadTokenPilotOpenCodeConfig,
  normalizeTokenPilotOpenCodeConfig,
  writeTokenPilotOpenCodeConfig,
} from "./config.js";

export const OPENCODE_LOADER_MARKER = "// tokenpilot-managed-loader: opencode";
export const OPENCODE_MCP_KEY = TOKENPILOT_MCP_SERVER_NAME;

export type OpenCodeMcpEntry = {
  type: "local";
  command: string[];
  environment: Record<string, string>;
  enabled: boolean;
};

export type OpenCodeInstallManifest = {
  version: 1;
  loaderPath: string;
  bundlePath: string;
  loaderBackupPath?: string;
  opencodeConfigPath: string;
  opencodeConfigCreated: boolean;
  opencodeConfigBackupPath?: string;
  mcpRegistered: boolean;
  tokenPilotConfigPath: string;
  tokenPilotConfigCreated: boolean;
  installedAt: string;
};

export type OpenCodeInstallPaths = {
  configDir: string;
  loaderPath: string;
  opencodeJsonPath: string;
  opencodeJsoncPath: string;
  tokenPilotConfigPath: string;
  manifestPath: string;
};

export function resolveOpenCodeInstallPaths(params?: { configDir?: string; tokenPilotConfigPath?: string }): OpenCodeInstallPaths {
  const configDir = params?.configDir ? resolve(params.configDir) : defaultOpenCodeConfigDir();
  return {
    configDir,
    loaderPath: join(configDir, "plugins", "tokenpilot.js"),
    opencodeJsonPath: join(configDir, "opencode.json"),
    opencodeJsoncPath: join(configDir, "opencode.jsonc"),
    tokenPilotConfigPath: params?.tokenPilotConfigPath ? resolve(params.tokenPilotConfigPath) : join(configDir, "tokenpilot.json"),
    manifestPath: join(configDir, "tokenpilot-install.json"),
  };
}

export function openCodeAdapterRoot(moduleDir = __dirname): string {
  let current = resolve(moduleDir);
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(current, "package.json")) && existsSync(join(current, "src", "plugin.ts"))) return current;
    current = dirname(current);
  }
  return resolve(moduleDir, "..");
}

export function renderOpenCodeLoader(bundlePath: string): string {
  return [
    OPENCODE_LOADER_MARKER,
    "// Installed by `npm --prefix components/adapters/opencode run install:opencode`. Remove with `uninstall:opencode`.",
    `export { default } from ${JSON.stringify(pathToFileURL(bundlePath).href)};`,
    "",
  ].join("\n");
}

export async function isTokenPilotOpenCodeLoader(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    return (await readFile(path, "utf8")).startsWith(OPENCODE_LOADER_MARKER);
  } catch {
    return false;
  }
}

export function buildOpenCodeMcpEntry(stateDir: string): { entry: OpenCodeMcpEntry; entryPath: string; built: boolean } {
  const spec = resolveTokenPilotMcpServerSpec({ stateDir, requireBuild: false });
  return {
    entry: { type: "local", command: [spec.command, ...spec.args], environment: { ...spec.env }, enabled: true },
    entryPath: spec.entryPath,
    built: existsSync(spec.entryPath),
  };
}

async function readManifest(path: string): Promise<OpenCodeInstallManifest | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as OpenCodeInstallManifest;
    return parsed?.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function installOpenCodeTokenPilot(params?: {
  configDir?: string;
  tokenPilotConfigPath?: string;
  bundlePath?: string;
  cliBinDir?: string;
  cliContextPath?: string;
  installCliBin?: boolean;
  now?: () => Date;
}): Promise<{
  paths: OpenCodeInstallPaths;
  bundlePath: string;
  loaderBackupPath?: string;
  tokenPilotConfigCreated: boolean;
  stateDir: string;
  mcp: {
    registered: boolean;
    reason: "registered" | "updated" | "jsonc_only" | "unparseable";
    entry: OpenCodeMcpEntry;
    serverBuilt: boolean;
    opencodeConfigCreated: boolean;
    backupPath?: string;
    snippet: string;
  };
  cliBin?: Awaited<ReturnType<typeof installLightRsiCliBin>>;
}> {
  const paths = resolveOpenCodeInstallPaths(params);
  const now = params?.now ?? (() => new Date());
  const bundlePath = params?.bundlePath ? resolve(params.bundlePath) : join(openCodeAdapterRoot(), "dist", "plugin.mjs");
  if (!existsSync(bundlePath)) {
    throw new Error(`OpenCode adapter bundle not built: ${bundlePath}. Run \`npm --prefix components/adapters/opencode run build\` first.`);
  }
  const previous = await readManifest(paths.manifestPath);

  // 1. Plugin loader.
  let loaderBackupPath = previous?.loaderBackupPath;
  if (existsSync(paths.loaderPath) && !(await isTokenPilotOpenCodeLoader(paths.loaderPath))) {
    loaderBackupPath = `${paths.loaderPath}.bak-${now().getTime()}`;
    await rename(paths.loaderPath, loaderBackupPath);
  }
  await mkdir(dirname(paths.loaderPath), { recursive: true });
  await writeFile(paths.loaderPath, renderOpenCodeLoader(bundlePath), "utf8");

  // 3 (first, so the MCP entry can carry the final state dir). TokenPilot config.
  const tokenPilotConfigCreated = !existsSync(paths.tokenPilotConfigPath);
  const config = tokenPilotConfigCreated
    ? normalizeTokenPilotOpenCodeConfig({}, { configPath: paths.tokenPilotConfigPath })
    : await loadTokenPilotOpenCodeConfig(paths.tokenPilotConfigPath);
  if (tokenPilotConfigCreated) await writeTokenPilotOpenCodeConfig(config, paths.tokenPilotConfigPath);
  await mkdir(config.stateDir, { recursive: true });

  // 2. Recovery MCP registration.
  const mcpSpec = buildOpenCodeMcpEntry(config.stateDir);
  const snippet = JSON.stringify({ mcp: { [OPENCODE_MCP_KEY]: mcpSpec.entry } }, null, 2);
  let mcp: Awaited<ReturnType<typeof installOpenCodeTokenPilot>>["mcp"];
  const jsonExists = existsSync(paths.opencodeJsonPath);
  if (!jsonExists && existsSync(paths.opencodeJsoncPath)) {
    mcp = { registered: false, reason: "jsonc_only", entry: mcpSpec.entry, serverBuilt: mcpSpec.built, opencodeConfigCreated: false, snippet };
  } else {
    let root: Record<string, unknown> | undefined = { $schema: "https://opencode.ai/config.json" };
    if (jsonExists) {
      try {
        const parsed = JSON.parse(await readFile(paths.opencodeJsonPath, "utf8"));
        root = isRecord(parsed) ? parsed : undefined;
      } catch {
        root = undefined;
      }
    }
    if (!root) {
      mcp = { registered: false, reason: "unparseable", entry: mcpSpec.entry, serverBuilt: mcpSpec.built, opencodeConfigCreated: false, snippet };
    } else {
      let backupPath: string | undefined;
      if (jsonExists) {
        backupPath = `${paths.opencodeJsonPath}.tokenpilot-backup-${now().getTime()}`;
        await copyFile(paths.opencodeJsonPath, backupPath);
      }
      const existingMcp = isRecord(root.mcp) ? root.mcp : {};
      const updated = OPENCODE_MCP_KEY in existingMcp;
      root = { ...root, mcp: { ...existingMcp, [OPENCODE_MCP_KEY]: mcpSpec.entry } };
      await mkdir(paths.configDir, { recursive: true });
      await writeFile(paths.opencodeJsonPath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
      mcp = {
        registered: true,
        reason: updated ? "updated" : "registered",
        entry: mcpSpec.entry,
        serverBuilt: mcpSpec.built,
        opencodeConfigCreated: !jsonExists,
        ...(backupPath ? { backupPath } : {}),
        snippet,
      };
    }
  }

  const manifest: OpenCodeInstallManifest = {
    version: 1,
    loaderPath: paths.loaderPath,
    bundlePath,
    ...(loaderBackupPath ? { loaderBackupPath } : {}),
    opencodeConfigPath: paths.opencodeJsonPath,
    opencodeConfigCreated: mcp.opencodeConfigCreated || previous?.opencodeConfigCreated === true,
    ...(mcp.backupPath ? { opencodeConfigBackupPath: mcp.backupPath } : previous?.opencodeConfigBackupPath ? { opencodeConfigBackupPath: previous.opencodeConfigBackupPath } : {}),
    mcpRegistered: mcp.registered || previous?.mcpRegistered === true,
    tokenPilotConfigPath: paths.tokenPilotConfigPath,
    tokenPilotConfigCreated: tokenPilotConfigCreated || previous?.tokenPilotConfigCreated === true,
    installedAt: now().toISOString(),
  };
  await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await rememberCliHostPathOverrides("opencode", {
    tokenPilotConfigPath: paths.tokenPilotConfigPath,
    hostConfigPath: paths.opencodeJsonPath,
  }, params?.cliContextPath);
  const cliBin = params?.installCliBin === false
    ? undefined
    : await installLightRsiCliBin({ adapterRoot: openCodeAdapterRoot(), binDir: params?.cliBinDir });

  return {
    paths,
    bundlePath,
    ...(loaderBackupPath ? { loaderBackupPath } : {}),
    tokenPilotConfigCreated,
    stateDir: config.stateDir,
    mcp,
    ...(cliBin ? { cliBin } : {}),
  };
}

export async function uninstallOpenCodeTokenPilot(params?: {
  configDir?: string;
  tokenPilotConfigPath?: string;
  purge?: boolean;
}): Promise<{
  loaderRemoved: boolean;
  loaderBackupRestored: boolean;
  foreignLoaderKept: boolean;
  mcpRemoved: boolean;
  opencodeConfigRemoved: boolean;
  configRemoved: boolean;
  stateRemoved: boolean;
}> {
  const paths = resolveOpenCodeInstallPaths(params);
  const manifest = await readManifest(paths.manifestPath);

  let loaderRemoved = false;
  let foreignLoaderKept = false;
  if (await isTokenPilotOpenCodeLoader(paths.loaderPath)) {
    await rm(paths.loaderPath);
    loaderRemoved = true;
  } else if (existsSync(paths.loaderPath)) {
    foreignLoaderKept = true;
  }
  let loaderBackupRestored = false;
  if (manifest?.loaderBackupPath && existsSync(manifest.loaderBackupPath) && !existsSync(paths.loaderPath)) {
    await rename(manifest.loaderBackupPath, paths.loaderPath);
    loaderBackupRestored = true;
  }

  let mcpRemoved = false;
  let opencodeConfigRemoved = false;
  if (manifest?.mcpRegistered && existsSync(paths.opencodeJsonPath)) {
    try {
      const root = JSON.parse(await readFile(paths.opencodeJsonPath, "utf8")) as Record<string, unknown>;
      if (isRecord(root.mcp) && OPENCODE_MCP_KEY in root.mcp) {
        const { [OPENCODE_MCP_KEY]: _removed, ...restMcp } = root.mcp;
        const next: Record<string, unknown> = { ...root };
        if (Object.keys(restMcp).length > 0) next.mcp = restMcp;
        else delete next.mcp;
        mcpRemoved = true;
        const onlySchemaLeft = Object.keys(next).every((key) => key === "$schema");
        if (manifest.opencodeConfigCreated && onlySchemaLeft) {
          await rm(paths.opencodeJsonPath);
          opencodeConfigRemoved = true;
        } else {
          await writeFile(paths.opencodeJsonPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
        }
      }
    } catch {
      // Leave an unparseable config alone; doctor will report the stale entry.
    }
  }

  let configRemoved = false;
  let stateRemoved = false;
  if (params?.purge) {
    const configPath = manifest?.tokenPilotConfigPath ?? paths.tokenPilotConfigPath;
    const stateDir = existsSync(configPath) ? (await loadTokenPilotOpenCodeConfig(configPath)).stateDir : undefined;
    if (manifest?.tokenPilotConfigCreated && existsSync(configPath)) {
      await rm(configPath);
      configRemoved = true;
    }
    if (stateDir && existsSync(stateDir)) {
      await rm(stateDir, { recursive: true, force: true });
      stateRemoved = true;
      const parent = dirname(stateDir);
      // rmdir only succeeds on an empty directory, so a shared parent is never removed.
      if (parent.endsWith("tokenpilot-state")) await rmdir(parent).catch(() => undefined);
    }
  }
  await rm(paths.manifestPath, { force: true });
  return { loaderRemoved, loaderBackupRestored, foreignLoaderKept, mcpRemoved, opencodeConfigRemoved, configRemoved, stateRemoved };
}
