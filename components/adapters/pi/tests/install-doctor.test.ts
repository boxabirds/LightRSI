/**
 * Regression matrix: pi/src/install.ts + pi/src/doctor.ts
 *
 * installPiTokenPilot
 *   I1 missing bundle → throws, nothing written
 *   I2 fresh agent dir → marker loader requiring the bundle; normal-mode config created;
 *      manifest (configCreated) and state dir written; CLI context remembers pi's config
 *   I3 existing TokenPilot loader → overwritten in place, no backup
 *   I4 foreign file at the loader path → moved to a timestamped backup, recorded in manifest
 *   I5 existing config → kept byte-identical (user settings and credentials untouched)
 *   I6 re-install keeps the first install's backup path and configCreated flag
 *   I7 the created config carries no credentials
 * renderPiLoader / isTokenPilotPiLoader / loaderTarget
 *   L1 the rendered loader re-exports the bundle's module (default export reachable)
 *   L2 marker detection: ours → true; foreign → false; missing → false
 *   L3 loaderTarget parses the required path; garbage → undefined
 * uninstallPiTokenPilot
 *   U1 removes our loader; keeps config and state without --purge
 *   U2 a foreign loader is left untouched
 *   U3 the recorded backup is restored
 *   U4 --purge removes a config it created and the state dir
 *   U5 --purge keeps a config that existed before install
 *   U6 uninstall without an install is a no-op
 *   U7 install → uninstall(--purge) leaves no TokenPilot files in the agent dir
 * inspectPiDoctor / formatPiDoctorReport
 *   D1 fresh install → healthy
 *   D2 nothing installed → unhealthy with config and loader problems
 *   D3 loader points to a missing bundle → problem
 *   D4 disabled config → problem
 *   D5 eviction requested but estimator incomplete → problem naming missing keys
 *   D6 latest session and activity are reported once written
 *   D7 formatted report lists every check and the health verdict
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordUxEffect, writeLatestSessionRef } from "@lightrsi/host-adapter";

import { loadTokenPilotPiConfig, normalizeTokenPilotPiConfig } from "../src/config.js";
import { formatPiDoctorReport, inspectPiDoctor, loaderTarget } from "../src/doctor.js";
import {
  PI_LOADER_MARKER,
  installPiTokenPilot,
  isTokenPilotPiLoader,
  renderPiLoader,
  uninstallPiTokenPilot,
} from "../src/install.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tp-pi-install-"));
  const agentDir = join(root, "agent");
  const bundlePath = join(root, "bundle", "extension.js");
  await mkdir(join(root, "bundle"), { recursive: true });
  await writeFile(bundlePath, "module.exports = { default: function tokenpilot() { return 'ok'; }, marker: 42 };\n");
  const cliContextPath = join(root, "cli-context.json");
  const install = (extra: Record<string, unknown> = {}) => installPiTokenPilot({
    agentDir, bundlePath, cliContextPath, installCliBin: false, ...extra,
  });
  return { root, agentDir, bundlePath, cliContextPath, install, loaderPath: join(agentDir, "extensions", "tokenpilot", "index.js"), configPath: join(agentDir, "tokenpilot.json") };
}

describe("installPiTokenPilot", () => {
  it("I1 a missing bundle throws before writing anything", async () => {
    const f = await fixture();
    await assert.rejects(f.install({ bundlePath: join(f.root, "none.js") }), /not built/);
    assert.equal(existsSync(f.agentDir), false);
  });
  it("I2 a fresh install writes loader, config, manifest, state dir and CLI context", async () => {
    const f = await fixture();
    const result = await f.install();
    assert.equal(await readFile(f.loaderPath, "utf8"), renderPiLoader(f.bundlePath));
    assert.equal(result.configCreated, true);
    assert.deepEqual(await loadTokenPilotPiConfig(f.configPath), normalizeTokenPilotPiConfig({}, { configPath: f.configPath }));
    const manifest = JSON.parse(await readFile(join(f.agentDir, "tokenpilot-install.json"), "utf8"));
    assert.equal(manifest.configCreated, true);
    assert.equal(manifest.bundlePath, f.bundlePath);
    assert.ok(existsSync(result.stateDir));
    const context = JSON.parse(await readFile(f.cliContextPath, "utf8"));
    assert.equal(context.configPathsByHost.pi.tokenPilotConfigPath, f.configPath);
  });
  it("I3 an existing TokenPilot loader is overwritten without a backup", async () => {
    const f = await fixture();
    await f.install();
    const second = await f.install();
    assert.equal(second.backupPath, undefined);
    assert.deepEqual((await readdir(join(f.agentDir, "extensions", "tokenpilot"))), ["index.js"]);
  });
  it("I4 a foreign loader is backed up and recorded", async () => {
    const f = await fixture();
    await mkdir(join(f.agentDir, "extensions", "tokenpilot"), { recursive: true });
    await writeFile(f.loaderPath, "export default () => 'mine';\n");
    const result = await f.install({ now: () => new Date(1_700_000_000_000) });
    assert.equal(result.backupPath, `${f.loaderPath}.bak-1700000000000`);
    assert.equal(await readFile(result.backupPath!, "utf8"), "export default () => 'mine';\n");
    const manifest = JSON.parse(await readFile(join(f.agentDir, "tokenpilot-install.json"), "utf8"));
    assert.equal(manifest.backupPath, result.backupPath);
  });
  it("I5 an existing config is kept byte-identical", async () => {
    const f = await fixture();
    await mkdir(f.agentDir, { recursive: true });
    const custom = `${JSON.stringify({ reduction: { maxToolChars: 1800 }, taskStateEstimator: { apiKey: "secret" } })}\n`;
    await writeFile(f.configPath, custom);
    const result = await f.install();
    assert.equal(result.configCreated, false);
    assert.equal(await readFile(f.configPath, "utf8"), custom);
  });
  it("I6 re-install keeps the first backup path and configCreated flag", async () => {
    const f = await fixture();
    await mkdir(join(f.agentDir, "extensions", "tokenpilot"), { recursive: true });
    await writeFile(f.loaderPath, "foreign\n");
    const first = await f.install();
    await f.install();
    const manifest = JSON.parse(await readFile(join(f.agentDir, "tokenpilot-install.json"), "utf8"));
    assert.equal(manifest.backupPath, first.backupPath);
    assert.equal(manifest.configCreated, true);
  });
  it("I7 the created config contains no credentials", async () => {
    const f = await fixture();
    await f.install();
    const raw = JSON.parse(await readFile(f.configPath, "utf8"));
    assert.equal(raw.taskStateEstimator.apiKey, undefined);
    assert.equal(raw.taskStateEstimator.baseUrl, undefined);
  });
});

describe("loader helpers", () => {
  it("L1 the loader re-exports the bundle", async () => {
    const f = await fixture();
    await f.install();
    const loaded = require(f.loaderPath) as { default: () => string; marker: number };
    assert.equal(loaded.default(), "ok");
    assert.equal(loaded.marker, 42);
  });
  it("L2 marker detection", async () => {
    const f = await fixture();
    assert.equal(await isTokenPilotPiLoader(f.loaderPath), false);
    await f.install();
    assert.equal(await isTokenPilotPiLoader(f.loaderPath), true);
    await writeFile(f.loaderPath, "not ours");
    assert.equal(await isTokenPilotPiLoader(f.loaderPath), false);
    assert.ok(renderPiLoader("/x").startsWith(PI_LOADER_MARKER));
  });
  it("L3 loaderTarget parses the required path", async () => {
    const f = await fixture();
    await f.install();
    assert.equal(loaderTarget(f.loaderPath), f.bundlePath);
    await writeFile(f.loaderPath, "garbage");
    assert.equal(loaderTarget(f.loaderPath), undefined);
    assert.equal(loaderTarget(join(f.root, "missing.js")), undefined);
  });
});

describe("uninstallPiTokenPilot", () => {
  it("U1 removes our loader and keeps config and state", async () => {
    const f = await fixture();
    const installed = await f.install();
    const result = await uninstallPiTokenPilot({ agentDir: f.agentDir });
    assert.equal(result.loaderRemoved, true);
    assert.equal(existsSync(f.loaderPath), false);
    assert.ok(existsSync(f.configPath));
    assert.ok(existsSync(installed.stateDir));
  });
  it("U2 leaves a foreign loader untouched", async () => {
    const f = await fixture();
    await f.install();
    await writeFile(f.loaderPath, "someone else's");
    const result = await uninstallPiTokenPilot({ agentDir: f.agentDir });
    assert.deepEqual([result.loaderRemoved, result.foreignLoaderKept], [false, true]);
    assert.equal(await readFile(f.loaderPath, "utf8"), "someone else's");
  });
  it("U3 restores the recorded backup", async () => {
    const f = await fixture();
    await mkdir(join(f.agentDir, "extensions", "tokenpilot"), { recursive: true });
    await writeFile(f.loaderPath, "original\n");
    await f.install();
    const result = await uninstallPiTokenPilot({ agentDir: f.agentDir });
    assert.equal(result.backupRestored, true);
    assert.equal(await readFile(f.loaderPath, "utf8"), "original\n");
  });
  it("U4 --purge removes a created config and the state dir", async () => {
    const f = await fixture();
    const installed = await f.install();
    const result = await uninstallPiTokenPilot({ agentDir: f.agentDir, purge: true });
    assert.deepEqual([result.configRemoved, result.stateRemoved], [true, true]);
    assert.equal(existsSync(f.configPath), false);
    assert.equal(existsSync(installed.stateDir), false);
  });
  it("U5 --purge keeps a config that predates the install", async () => {
    const f = await fixture();
    await mkdir(f.agentDir, { recursive: true });
    await writeFile(f.configPath, "{}\n");
    await f.install();
    const result = await uninstallPiTokenPilot({ agentDir: f.agentDir, purge: true });
    assert.equal(result.configRemoved, false);
    assert.ok(existsSync(f.configPath));
  });
  it("U6 uninstall without an install is a no-op", async () => {
    const f = await fixture();
    assert.deepEqual(await uninstallPiTokenPilot({ agentDir: f.agentDir }), {
      loaderRemoved: false, backupRestored: false, foreignLoaderKept: false, configRemoved: false, stateRemoved: false,
    });
  });
  it("U7 install then purge leaves no TokenPilot files behind", async () => {
    const f = await fixture();
    await mkdir(join(f.agentDir, "extensions"), { recursive: true });
    await f.install();
    await uninstallPiTokenPilot({ agentDir: f.agentDir, purge: true });
    const remaining = await readdir(f.agentDir, { recursive: true });
    assert.deepEqual(remaining.filter((entry) => /tokenpilot/i.test(String(entry))), []);
  });
});

describe("doctor", () => {
  async function installed() {
    const f = await fixture();
    await f.install();
    const config = await loadTokenPilotPiConfig(f.configPath);
    const inspect = (cfg = config) => inspectPiDoctor({ config: cfg, configPath: f.configPath, agentDir: f.agentDir, detectVersion: false });
    return { ...f, config, inspect };
  }
  it("D1 a fresh install is healthy", async () => {
    const f = await installed();
    const report = await f.inspect();
    assert.deepEqual(report.problems, []);
    assert.equal(report.healthy, true);
    assert.deepEqual(report.declaredFeatures, ["stabilizer", "reduction", "eviction"]);
  });
  it("D2 nothing installed is unhealthy", async () => {
    const f = await fixture();
    const configPath = join(f.agentDir, "tokenpilot.json");
    const report = await inspectPiDoctor({ config: normalizeTokenPilotPiConfig({}, { configPath }), configPath, agentDir: f.agentDir, detectVersion: false });
    assert.equal(report.healthy, false);
    assert.ok(report.problems.some((p) => p.startsWith("config missing")));
    assert.ok(report.problems.some((p) => p.startsWith("pi loader missing")));
  });
  it("D3 a loader pointing to a missing bundle is reported", async () => {
    const f = await installed();
    await rm(f.bundlePath);
    const report = await f.inspect();
    assert.ok(report.problems.some((p) => p.startsWith("loader points to a missing bundle")));
  });
  it("D4 a disabled config is reported", async () => {
    const f = await installed();
    const report = await f.inspect({ ...f.config, enabled: false });
    assert.ok(report.problems.includes("adapter disabled in config (enabled=false)"));
  });
  it("D5 incomplete eviction settings are reported with the missing keys", async () => {
    const f = await installed();
    const config = normalizeTokenPilotPiConfig({ stateDir: f.config.stateDir, modules: { eviction: true }, eviction: { enabled: true }, taskStateEstimator: { baseUrl: "http://x" } });
    const report = await f.inspect(config);
    assert.ok(report.problems.includes("eviction requested but inactive: estimator_incomplete (missing model, apiKey)"));
  });
  it("D6 latest session and activity are reported", async () => {
    const f = await installed();
    await writeLatestSessionRef(f.config.stateDir, "sess-9", "2026-09-28T00:00:00.000Z");
    await recordUxEffect(f.config.stateDir, { at: "2026-09-28T00:00:01.000Z", sessionId: "sess-9", model: "qwen3", countMode: "chars", beforeCount: 10, afterCount: 5, savedCount: 5 });
    const report = await f.inspect();
    assert.equal(report.latestSessionId, "sess-9");
    assert.equal(report.latestActivityAt, "2026-09-28T00:00:01.000Z");
  });
  it("D7 the formatted report lists every check", async () => {
    const f = await installed();
    const text = formatPiDoctorReport(await f.inspect());
    for (const label of ["tokenpilot config", "enabled", "pi version", "extension loader", "extension bundle", "stateDir", "declared features", "stabilizer", "reduction", "recovery", "eviction", "latest session", "latest activity", "adapter log", "healthy: yes"]) {
      assert.ok(text.includes(`- ${label}`), label);
    }
  });
});
