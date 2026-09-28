/**
 * Regression matrix: opencode/src/install.ts + opencode/src/doctor.ts
 *
 * installOpenCodeTokenPilot — plugin loader
 *   I1 missing bundle → throws, nothing written
 *   I2 fresh config dir → marker ESM loader re-exporting the bundle URL; normal-mode
 *      tokenpilot.json; state dir; manifest; CLI context remembers both config paths
 *   I3 foreign file at the loader path → timestamped backup, recorded
 *   I4 existing tokenpilot.json kept byte-identical; no credentials ever written
 * installOpenCodeTokenPilot — recovery MCP registration (partitioned by opencode config state)
 *   J1 no opencode.json / .jsonc → opencode.json created with $schema + mcp entry
 *   J2 existing opencode.json → backup written, other keys and other MCP servers kept
 *   J3 existing entry → replaced (reason "updated")
 *   J4 only opencode.jsonc → nothing written, reason jsonc_only, snippet returned
 *   J5 unparseable opencode.json → nothing written, reason unparseable
 *   J6 entry shape: local, [node, server.js], TOKENPILOT_STATE_DIR = state dir, enabled
 * renderOpenCodeLoader / openCodeLoaderTarget / isTokenPilotOpenCodeLoader
 *   L1 round trip loader → bundle path;  L2 marker detection
 * uninstallOpenCodeTokenPilot
 *   U1 removes loader and only our MCP key; other keys and servers kept
 *   U2 opencode.json created by install and now empty → removed
 *   U3 loader backup restored; foreign loader kept
 *   U4 --purge removes created tokenpilot.json + state; keeps a pre-existing one
 *   U5 uninstall without install → no-op
 * inspectOpenCodeDoctor
 *   D1 fresh install → healthy, MCP matches, probe ok
 *   D2 nothing installed → config, loader and MCP problems
 *   D3 MCP entry pointing at another state dir → mismatch problem
 *   D4 jsonc-only config → problem pointing at the snippet
 *   D5 native pruning on → warning; off by default
 *   D6 user target → warning
 *   D7 formatted report lists every check
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTokenPilotOpenCodeConfig, normalizeTokenPilotOpenCodeConfig } from "../src/config.js";
import { formatOpenCodeDoctorReport, inspectOpenCodeDoctor, openCodeLoaderTarget } from "../src/doctor.js";
import {
  OPENCODE_LOADER_MARKER,
  OPENCODE_MCP_KEY,
  installOpenCodeTokenPilot,
  isTokenPilotOpenCodeLoader,
  renderOpenCodeLoader,
  uninstallOpenCodeTokenPilot,
} from "../src/install.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tp-oc-install-"));
  const configDir = join(root, "opencode");
  const bundlePath = join(root, "bundle", "plugin.mjs");
  await mkdir(join(root, "bundle"), { recursive: true });
  await writeFile(bundlePath, "export default { id: 'tokenpilot', server: async () => ({}) };\n");
  const cliContextPath = join(root, "cli-context.json");
  return {
    root, configDir, bundlePath, cliContextPath,
    loaderPath: join(configDir, "plugins", "tokenpilot.js"),
    jsonPath: join(configDir, "opencode.json"),
    jsoncPath: join(configDir, "opencode.jsonc"),
    tpConfigPath: join(configDir, "tokenpilot.json"),
    install: (extra: Record<string, unknown> = {}) => installOpenCodeTokenPilot({ configDir, bundlePath, cliContextPath, installCliBin: false, ...extra }),
    uninstall: (extra: Record<string, unknown> = {}) => uninstallOpenCodeTokenPilot({ configDir, ...extra }),
  };
}

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

describe("install: plugin loader", () => {
  it("I1 a missing bundle throws before writing", async () => {
    const f = await fixture();
    await assert.rejects(f.install({ bundlePath: join(f.root, "none.mjs") }), /not built/);
    assert.equal(existsSync(f.configDir), false);
  });
  it("I2 a fresh install writes loader, config, state, manifest and CLI context", async () => {
    const f = await fixture();
    const result = await f.install();
    assert.equal(await readFile(f.loaderPath, "utf8"), renderOpenCodeLoader(f.bundlePath));
    assert.equal(result.tokenPilotConfigCreated, true);
    assert.deepEqual(await loadTokenPilotOpenCodeConfig(f.tpConfigPath), normalizeTokenPilotOpenCodeConfig({}, { configPath: f.tpConfigPath }));
    assert.ok(existsSync(result.stateDir));
    assert.ok(existsSync(join(f.configDir, "tokenpilot-install.json")));
    const context = await readJson(f.cliContextPath);
    assert.deepEqual(context.configPathsByHost.opencode, { tokenPilotConfigPath: f.tpConfigPath, hostConfigPath: f.jsonPath });
  });
  it("I3 a foreign plugin file is backed up", async () => {
    const f = await fixture();
    await mkdir(join(f.configDir, "plugins"), { recursive: true });
    await writeFile(f.loaderPath, "export default {};\n");
    const result = await f.install({ now: () => new Date(1_700_000_000_000) });
    assert.equal(result.loaderBackupPath, `${f.loaderPath}.bak-1700000000000`);
    assert.equal(await readFile(result.loaderBackupPath!, "utf8"), "export default {};\n");
  });
  it("I4 an existing tokenpilot.json is kept and no credentials are written", async () => {
    const f = await fixture();
    await mkdir(f.configDir, { recursive: true });
    const custom = `${JSON.stringify({ reduction: { maxToolChars: 1800 } })}\n`;
    await writeFile(f.tpConfigPath, custom);
    const result = await f.install();
    assert.equal(result.tokenPilotConfigCreated, false);
    assert.equal(await readFile(f.tpConfigPath, "utf8"), custom);
    const fresh = await fixture();
    await fresh.install();
    assert.equal((await readJson(fresh.tpConfigPath)).taskStateEstimator.apiKey, undefined);
  });
});

describe("install: recovery MCP registration", () => {
  it("J1 creates opencode.json when none exists", async () => {
    const f = await fixture();
    const result = await f.install();
    assert.deepEqual([result.mcp.registered, result.mcp.reason, result.mcp.opencodeConfigCreated], [true, "registered", true]);
    const root = await readJson(f.jsonPath);
    assert.equal(root.$schema, "https://opencode.ai/config.json");
    assert.ok(root.mcp[OPENCODE_MCP_KEY]);
  });
  it("J2 updates an existing opencode.json with a backup, keeping other settings", async () => {
    const f = await fixture();
    await mkdir(f.configDir, { recursive: true });
    const original = { model: "llama/qwen3", mcp: { other: { type: "remote", url: "https://x" } } };
    await writeFile(f.jsonPath, JSON.stringify(original));
    const result = await f.install({ now: () => new Date(1_700_000_000_000) });
    assert.equal(result.mcp.backupPath, `${f.jsonPath}.tokenpilot-backup-1700000000000`);
    assert.deepEqual(await readJson(result.mcp.backupPath!), original);
    const root = await readJson(f.jsonPath);
    assert.equal(root.model, "llama/qwen3");
    assert.deepEqual(root.mcp.other, original.mcp.other);
    assert.ok(root.mcp[OPENCODE_MCP_KEY]);
  });
  it("J3 replaces an existing TokenPilot entry", async () => {
    const f = await fixture();
    await mkdir(f.configDir, { recursive: true });
    await writeFile(f.jsonPath, JSON.stringify({ mcp: { [OPENCODE_MCP_KEY]: { type: "local", command: ["old"] } } }));
    const result = await f.install();
    assert.equal(result.mcp.reason, "updated");
    assert.notDeepEqual((await readJson(f.jsonPath)).mcp[OPENCODE_MCP_KEY].command, ["old"]);
  });
  it("J4 never rewrites an opencode.jsonc-only setup", async () => {
    const f = await fixture();
    await mkdir(f.configDir, { recursive: true });
    await writeFile(f.jsoncPath, "{ // my comments\n}\n");
    const result = await f.install();
    assert.deepEqual([result.mcp.registered, result.mcp.reason], [false, "jsonc_only"]);
    assert.equal(existsSync(f.jsonPath), false);
    assert.equal(await readFile(f.jsoncPath, "utf8"), "{ // my comments\n}\n");
    assert.ok(result.mcp.snippet.includes(OPENCODE_MCP_KEY));
  });
  it("J5 leaves an unparseable opencode.json untouched", async () => {
    const f = await fixture();
    await mkdir(f.configDir, { recursive: true });
    await writeFile(f.jsonPath, "{ nope");
    const result = await f.install();
    assert.deepEqual([result.mcp.registered, result.mcp.reason], [false, "unparseable"]);
    assert.equal(await readFile(f.jsonPath, "utf8"), "{ nope");
  });
  it("J6 the entry runs the shared recovery server against the state dir", async () => {
    const f = await fixture();
    const result = await f.install();
    const entry = (await readJson(f.jsonPath)).mcp[OPENCODE_MCP_KEY];
    assert.equal(entry.type, "local");
    assert.equal(entry.command[0], process.execPath);
    assert.match(entry.command[1], /products[\\/]mcp[\\/]dist[\\/]server\.js$/);
    assert.deepEqual(entry.environment, { TOKENPILOT_STATE_DIR: result.stateDir });
    assert.equal(entry.enabled, true);
  });
});

describe("loader helpers", () => {
  it("L1 the loader target round-trips", async () => {
    const f = await fixture();
    await f.install();
    assert.equal(openCodeLoaderTarget(f.loaderPath), f.bundlePath);
    await writeFile(f.loaderPath, "garbage");
    assert.equal(openCodeLoaderTarget(f.loaderPath), undefined);
  });
  it("L2 marker detection", async () => {
    const f = await fixture();
    assert.equal(await isTokenPilotOpenCodeLoader(f.loaderPath), false);
    await f.install();
    assert.equal(await isTokenPilotOpenCodeLoader(f.loaderPath), true);
    assert.ok(renderOpenCodeLoader("/x").startsWith(OPENCODE_LOADER_MARKER));
  });
});

describe("uninstallOpenCodeTokenPilot", () => {
  it("U1 removes the loader and only our MCP key", async () => {
    const f = await fixture();
    await mkdir(f.configDir, { recursive: true });
    await writeFile(f.jsonPath, JSON.stringify({ model: "m", mcp: { other: { type: "remote", url: "https://x" } } }));
    await f.install();
    const result = await f.uninstall();
    assert.deepEqual([result.loaderRemoved, result.mcpRemoved, result.opencodeConfigRemoved], [true, true, false]);
    assert.deepEqual(await readJson(f.jsonPath), { model: "m", mcp: { other: { type: "remote", url: "https://x" } } });
  });
  it("U2 an opencode.json created by install and now empty is removed", async () => {
    const f = await fixture();
    await f.install();
    const result = await f.uninstall();
    assert.equal(result.opencodeConfigRemoved, true);
    assert.equal(existsSync(f.jsonPath), false);
  });
  it("U3 restores a loader backup and keeps a foreign loader", async () => {
    const f = await fixture();
    await mkdir(join(f.configDir, "plugins"), { recursive: true });
    await writeFile(f.loaderPath, "mine\n");
    await f.install();
    const restored = await f.uninstall();
    assert.equal(restored.loaderBackupRestored, true);
    assert.equal(await readFile(f.loaderPath, "utf8"), "mine\n");
    const g = await fixture();
    await g.install();
    await writeFile(g.loaderPath, "someone else\n");
    assert.equal((await g.uninstall()).foreignLoaderKept, true);
  });
  it("U4 --purge removes created config and state, keeps a pre-existing config", async () => {
    const f = await fixture();
    const installed = await f.install();
    const purged = await f.uninstall({ purge: true });
    assert.deepEqual([purged.configRemoved, purged.stateRemoved], [true, true]);
    assert.equal(existsSync(installed.stateDir), false);
    assert.equal(existsSync(join(f.configDir, "tokenpilot-state")), false);
    const g = await fixture();
    await mkdir(g.configDir, { recursive: true });
    await writeFile(g.tpConfigPath, "{}\n");
    await g.install();
    assert.equal((await g.uninstall({ purge: true })).configRemoved, false);
    assert.ok(existsSync(g.tpConfigPath));
  });
  it("U5 uninstall without an install is a no-op", async () => {
    const f = await fixture();
    assert.deepEqual(await f.uninstall(), {
      loaderRemoved: false, loaderBackupRestored: false, foreignLoaderKept: false, mcpRemoved: false,
      opencodeConfigRemoved: false, configRemoved: false, stateRemoved: false,
    });
  });
});

describe("doctor", () => {
  async function installed() {
    const f = await fixture();
    await f.install();
    const config = await loadTokenPilotOpenCodeConfig(f.tpConfigPath);
    const inspect = (cfg = config, probeMcp = false) => inspectOpenCodeDoctor({ config: cfg, configPath: f.tpConfigPath, configDir: f.configDir, detectVersion: false, probeMcp });
    return { ...f, config, inspect };
  }
  it("D1 a fresh install is healthy and the MCP server answers", async () => {
    const f = await installed();
    const report = await f.inspect(f.config, true);
    assert.deepEqual(report.problems, []);
    assert.equal(report.mcpMatchesExpected, true);
    assert.equal(report.mcpProbe?.ok, true);
    assert.equal(report.nativePrune, "off");
    assert.deepEqual(report.declaredFeatures, ["stabilizer", "reduction", "eviction"]);
  });
  it("D2 nothing installed is unhealthy", async () => {
    const f = await fixture();
    const report = await inspectOpenCodeDoctor({
      config: normalizeTokenPilotOpenCodeConfig({}, { configPath: f.tpConfigPath }), configPath: f.tpConfigPath, configDir: f.configDir, detectVersion: false, probeMcp: false,
    });
    for (const prefix of ["config missing", "plugin loader missing", "recovery MCP not registered"]) {
      assert.ok(report.problems.some((p) => p.startsWith(prefix)), prefix);
    }
  });
  it("D3 an MCP entry for another state dir is a mismatch", async () => {
    const f = await installed();
    const root = await readJson(f.jsonPath);
    root.mcp[OPENCODE_MCP_KEY].environment.TOKENPILOT_STATE_DIR = "/elsewhere";
    await writeFile(f.jsonPath, JSON.stringify(root));
    const report = await f.inspect();
    assert.equal(report.mcpMatchesExpected, false);
    assert.ok(report.problems.some((p) => p.startsWith("recovery MCP entry does not match")));
  });
  it("D4 a jsonc-only setup points at the snippet", async () => {
    const f = await fixture();
    await mkdir(f.configDir, { recursive: true });
    await writeFile(f.jsoncPath, "{}\n");
    await f.install();
    const report = await inspectOpenCodeDoctor({ config: await loadTokenPilotOpenCodeConfig(f.tpConfigPath), configPath: f.tpConfigPath, configDir: f.configDir, detectVersion: false, probeMcp: false });
    assert.equal(report.opencodeConfigState, "jsonc_only");
    assert.ok(report.problems.some((p) => p.includes("paste the snippet")));
  });
  it("D5 native pruning is reported when on", async () => {
    const f = await installed();
    const root = await readJson(f.jsonPath);
    await writeFile(f.jsonPath, JSON.stringify({ ...root, compaction: { prune: true } }));
    const report = await f.inspect();
    assert.equal(report.nativePrune, "on");
    assert.ok(report.warnings.some((w) => w.includes("native pruning")));
  });
  it("D6 user target is reported as unsupported", async () => {
    const f = await installed();
    const report = await f.inspect({ ...f.config, hooks: { dynamicContextTarget: "user" } });
    assert.ok(report.warnings.some((w) => w.startsWith("dynamicContextTarget=user is not supported")));
    assert.equal(report.healthy, true);
  });
  it("D7 the formatted report lists every check", async () => {
    const f = await installed();
    const text = formatOpenCodeDoctorReport(await f.inspect());
    for (const label of ["tokenpilot config", "enabled", "opencode version", "plugin loader", "plugin bundle", "opencode config", "recovery MCP registered", "recovery MCP server built", "recovery MCP probe", "native tool-output pruning", "stateDir", "declared features", "stabilizer", "reduction", "recovery protocol injected", "eviction", "latest session", "latest activity", "adapter log", "healthy: yes"]) {
      assert.ok(text.includes(`- ${label}`), label);
    }
  });
});
