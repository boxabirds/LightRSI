/**
 * Reversible install for the pi adapter.
 *
 * install:   writes a marker-tagged loader at `<agent-dir>/extensions/tokenpilot/index.js`
 *            that requires the built `dist/extension.js`, and writes
 *            `<agent-dir>/tokenpilot.json` in normal mode if it does not exist yet.
 *            No pi-owned file is modified. A pre-existing non-TokenPilot file at the
 *            loader path is moved to a timestamped backup first.
 * uninstall: removes the loader only if it carries the marker, restores the backup
 *            recorded at install time, and (with `purge`) removes the config and
 *            state this install created. Credentials are never written by install.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { installLightRsiCliBin } from "../../shared/cli-bin-install.js";
import { rememberCliHostPathOverrides } from "../../shared/cli-context.js";
import {
  defaultPiAgentDir,
  defaultTokenPilotPiConfigPath,
  loadTokenPilotPiConfig,
  normalizeTokenPilotPiConfig,
  writeTokenPilotPiConfig,
} from "./config.js";

export const PI_LOADER_MARKER = "// tokenpilot-managed-loader: pi";

export type PiInstallManifest = {
  version: 1;
  loaderPath: string;
  bundlePath: string;
  backupPath?: string;
  configPath: string;
  configCreated: boolean;
  installedAt: string;
};

export type PiInstallPaths = {
  agentDir: string;
  loaderDir: string;
  loaderPath: string;
  configPath: string;
  manifestPath: string;
};

export function resolvePiInstallPaths(params?: { agentDir?: string; configPath?: string }): PiInstallPaths {
  const agentDir = params?.agentDir ? resolve(params.agentDir) : defaultPiAgentDir();
  const loaderDir = join(agentDir, "extensions", "tokenpilot");
  return {
    agentDir,
    loaderDir,
    loaderPath: join(loaderDir, "index.js"),
    configPath: params?.configPath ? resolve(params.configPath) : (params?.agentDir ? join(agentDir, "tokenpilot.json") : defaultTokenPilotPiConfigPath()),
    manifestPath: join(agentDir, "tokenpilot-install.json"),
  };
}

export function piAdapterRoot(moduleDir = __dirname): string {
  let current = resolve(moduleDir);
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(current, "package.json")) && existsSync(join(current, "src", "extension.ts"))) return current;
    current = dirname(current);
  }
  return resolve(moduleDir, "..");
}

export function renderPiLoader(bundlePath: string): string {
  return [
    PI_LOADER_MARKER,
    "// Installed by `npm --prefix components/adapters/pi run install:pi`. Remove with `uninstall:pi`.",
    `module.exports = require(${JSON.stringify(bundlePath)});`,
    "",
  ].join("\n");
}

export async function isTokenPilotPiLoader(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    return (await readFile(path, "utf8")).startsWith(PI_LOADER_MARKER);
  } catch {
    return false;
  }
}

async function readManifest(path: string): Promise<PiInstallManifest | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as PiInstallManifest;
    return parsed && parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function installPiTokenPilot(params?: {
  agentDir?: string;
  configPath?: string;
  bundlePath?: string;
  cliBinDir?: string;
  cliContextPath?: string;
  installCliBin?: boolean;
  now?: () => Date;
}): Promise<{
  paths: PiInstallPaths;
  bundlePath: string;
  loaderWritten: boolean;
  backupPath?: string;
  configCreated: boolean;
  stateDir: string;
  cliBin?: Awaited<ReturnType<typeof installLightRsiCliBin>>;
}> {
  const paths = resolvePiInstallPaths(params);
  const now = params?.now ?? (() => new Date());
  const bundlePath = params?.bundlePath ? resolve(params.bundlePath) : join(piAdapterRoot(), "dist", "extension.js");
  if (!existsSync(bundlePath)) {
    throw new Error(`pi adapter bundle not built: ${bundlePath}. Run \`npm --prefix components/adapters/pi run build\` first.`);
  }

  const previous = await readManifest(paths.manifestPath);
  let backupPath = previous?.backupPath;
  if (existsSync(paths.loaderPath) && !(await isTokenPilotPiLoader(paths.loaderPath))) {
    backupPath = `${paths.loaderPath}.bak-${now().getTime()}`;
    await rename(paths.loaderPath, backupPath);
  }
  await mkdir(paths.loaderDir, { recursive: true });
  await writeFile(paths.loaderPath, renderPiLoader(bundlePath), "utf8");

  const configCreated = !existsSync(paths.configPath);
  const config = configCreated
    ? normalizeTokenPilotPiConfig({}, { configPath: paths.configPath })
    : await loadTokenPilotPiConfig(paths.configPath);
  if (configCreated) await writeTokenPilotPiConfig(config, paths.configPath);
  await mkdir(config.stateDir, { recursive: true });

  const manifest: PiInstallManifest = {
    version: 1,
    loaderPath: paths.loaderPath,
    bundlePath,
    ...(backupPath ? { backupPath } : {}),
    configPath: paths.configPath,
    configCreated: configCreated || previous?.configCreated === true,
    installedAt: now().toISOString(),
  };
  await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await rememberCliHostPathOverrides("pi", { tokenPilotConfigPath: paths.configPath }, params?.cliContextPath);
  const cliBin = params?.installCliBin === false
    ? undefined
    : await installLightRsiCliBin({ adapterRoot: piAdapterRoot(), binDir: params?.cliBinDir });

  return {
    paths,
    bundlePath,
    loaderWritten: true,
    ...(backupPath ? { backupPath } : {}),
    configCreated,
    stateDir: config.stateDir,
    ...(cliBin ? { cliBin } : {}),
  };
}

export async function uninstallPiTokenPilot(params?: {
  agentDir?: string;
  configPath?: string;
  purge?: boolean;
}): Promise<{
  loaderRemoved: boolean;
  backupRestored: boolean;
  foreignLoaderKept: boolean;
  configRemoved: boolean;
  stateRemoved: boolean;
}> {
  const paths = resolvePiInstallPaths(params);
  const manifest = await readManifest(paths.manifestPath);
  let loaderRemoved = false;
  let foreignLoaderKept = false;
  if (await isTokenPilotPiLoader(paths.loaderPath)) {
    await rm(paths.loaderPath);
    loaderRemoved = true;
  } else if (existsSync(paths.loaderPath)) {
    foreignLoaderKept = true;
  }

  let backupRestored = false;
  if (manifest?.backupPath && existsSync(manifest.backupPath) && !existsSync(paths.loaderPath)) {
    await rename(manifest.backupPath, paths.loaderPath);
    backupRestored = true;
  }
  if (existsSync(paths.loaderDir) && (await readdir(paths.loaderDir)).length === 0) {
    await rmdir(paths.loaderDir);
  }

  let configRemoved = false;
  let stateRemoved = false;
  if (params?.purge) {
    const configPath = manifest?.configPath ?? paths.configPath;
    const stateDir = existsSync(configPath) ? (await loadTokenPilotPiConfig(configPath)).stateDir : undefined;
    if (manifest?.configCreated && existsSync(configPath)) {
      await rm(configPath);
      configRemoved = true;
    }
    if (stateDir && existsSync(stateDir)) {
      await rm(stateDir, { recursive: true, force: true });
      stateRemoved = true;
      // Default layout is <agent-dir>/tokenpilot-state/tokenpilot; drop the parent if now empty.
      const parent = dirname(stateDir);
      if (parent.endsWith("tokenpilot-state") && existsSync(parent) && (await readdir(parent)).length === 0) {
        await rmdir(parent);
      }
    }
  }
  await rm(paths.manifestPath, { force: true });
  return { loaderRemoved, backupRestored, foreignLoaderKept, configRemoved, stateRemoved };
}
