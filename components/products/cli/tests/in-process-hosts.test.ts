/**
 * Regression matrix: OpenCode registration in the shared CLI
 * (hosts/in-process.ts, hosts/opencode.ts, registry, factory, dispatch, usage)
 *
 * Registration
 *   H1 CLI_HOSTS lists opencode after the existing hosts (order preserved)
 *   H2 parseCliHostId accepts "opencode"
 *   H3 usage lists the host and an example
 * Command surface
 *   C1 status prints every shared key for the host's config
 *   C2 mode conservative / normal write the standard presets; aggressive refused;
 *      anything else prints usage
 *   C3 reduction pass <known> <on|off> is written; unknown pass names are rejected
 *   C4 eviction on sets modules.eviction, eviction.enabled, taskStateEstimator.enabled;
 *      eviction set minBlockChars writes eviction.minBlockChars; other subcommands refused
 *   C5 stabilizer target user writes hooks.dynamicContextTarget
 *   C6 doctor returns the host's own doctor report
 *   C7 report: no activity → "No TokenPilot session stats yet."; with activity →
 *      report for the latest session
 *   C8 the TOKENPILOT_OPENCODE_CONFIG env override selects the config file
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordUxEffect, writeLatestSessionRef } from "@lightrsi/host-adapter";

import { dispatchCli } from "../src/dispatch.js";
import { CLI_HOSTS, parseCliHostId } from "../src/hosts/registry.js";
import { formatCliUsage } from "../src/usage.js";

const saved = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  TOKENPILOT_OPENCODE_CONFIG: process.env.TOKENPILOT_OPENCODE_CONFIG,
  TOKENPILOT_OPENCODE_CONFIG_DIR: process.env.TOKENPILOT_OPENCODE_CONFIG_DIR,
};
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const HOSTS = [
  { id: "opencode", env: "TOKENPILOT_OPENCODE_CONFIG", doctorTitle: "TokenPilot OpenCode doctor:", statusTitle: "TokenPilot OpenCode status:" },
] as const;

async function isolate(host: (typeof HOSTS)[number]): Promise<{ configPath: string; home: string }> {
  const home = await mkdtemp(join(tmpdir(), `lightrsi-cli-${host.id}-`));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const configPath = join(home, host.id, "tokenpilot.json");
  process.env[host.env] = configPath;
  if (host.id === "opencode") process.env.TOKENPILOT_OPENCODE_CONFIG_DIR = join(home, "opencode");
  return { configPath, home };
}

const readConfig = async (path: string) => JSON.parse(await readFile(path, "utf8"));

describe("registration", () => {
  it("H1 hosts are appended in order", () => {
    assert.deepEqual(CLI_HOSTS.map((h) => h.hostId), ["openclaw", "codex", "claude-code", "opencode"]);
  });
  it("H2 host ids parse", () => {
    assert.equal(parseCliHostId("opencode"), "opencode");
  });
  it("H3 usage lists the host", () => {
    const usage = formatCliUsage();
    for (const text of ["  opencode\n", "lightrsi opencode report"]) assert.ok(usage.includes(text), text);
  });
});

for (const host of HOSTS) {
  describe(`${host.id} command surface`, () => {
    it("C1 status lists every shared key", async () => {
      await isolate(host);
      const { text } = await dispatchCli([host.id, "status"]);
      assert.ok(text.startsWith(host.statusTitle));
      for (const key of ["enabled", "stabilizer", "dynamicContextTarget", "reduction", "triggerMinChars", "maxToolChars", "eviction", "evictionMinBlockChars", "stateDir"]) {
        assert.ok(text.includes(`- ${key}:`), key);
      }
    });
    it("C2 modes", async () => {
      const { configPath } = await isolate(host);
      assert.equal((await dispatchCli([host.id, "mode", "conservative"])).text, "✅ Runtime mode = conservative");
      assert.deepEqual([(await readConfig(configPath)).reduction.triggerMinChars, (await readConfig(configPath)).reduction.maxToolChars], [4000, 1800]);
      await dispatchCli([host.id, "mode", "normal"]);
      assert.deepEqual([(await readConfig(configPath)).reduction.triggerMinChars, (await readConfig(configPath)).reduction.maxToolChars], [2200, 1200]);
      assert.match((await dispatchCli([host.id, "mode", "aggressive"])).text, /does not support lifecycle eviction mode/);
      assert.match((await dispatchCli([host.id, "mode", "turbo"])).text, /^Usage: lightrsi .* mode <conservative\|normal>/);
    });
    it("C3 reduction passes", async () => {
      const { configPath } = await isolate(host);
      await dispatchCli([host.id, "reduction", "pass", "htmlSlimming", "off"]);
      assert.equal((await readConfig(configPath)).reduction.passes.htmlSlimming, false);
      assert.match((await dispatchCli([host.id, "reduction", "pass", "bogus", "off"])).text, /supports only these passes/);
    });
    it("C4 eviction controls", async () => {
      const { configPath } = await isolate(host);
      await dispatchCli([host.id, "eviction", "on"]);
      const on = await readConfig(configPath);
      assert.deepEqual([on.modules.eviction, on.eviction.enabled, on.taskStateEstimator.enabled], [true, true, true]);
      await dispatchCli([host.id, "eviction", "set", "minBlockChars", "8000"]);
      assert.equal((await readConfig(configPath)).eviction.minBlockChars, 8000);
      assert.match((await dispatchCli([host.id, "eviction", "policy", "lru"])).text, /eviction supports only status, on\|off, and set minBlockChars/);
    });
    it("C5 stabilizer target", async () => {
      const { configPath } = await isolate(host);
      await dispatchCli([host.id, "stabilizer", "target", "user"]);
      assert.equal((await readConfig(configPath)).hooks.dynamicContextTarget, "user");
    });
    it("C6 doctor is the host's report", async () => {
      await isolate(host);
      const { text } = await dispatchCli([host.id, "doctor"]);
      assert.ok(text.startsWith(host.doctorTitle), text.split("\n")[0]);
    });
    it("C7 report before and after activity", async () => {
      const { configPath } = await isolate(host);
      await dispatchCli([host.id, "mode", "normal"]);
      assert.equal((await dispatchCli([host.id, "report"])).text, "No TokenPilot session stats yet.");
      const stateDir = (await readConfig(configPath)).stateDir as string;
      await writeLatestSessionRef(stateDir, "sess-report", new Date().toISOString());
      await recordUxEffect(stateDir, { at: new Date().toISOString(), sessionId: "sess-report", model: "qwen3", countMode: "chars", beforeCount: 1000, afterCount: 400, savedCount: 600 });
      const { text } = await dispatchCli([host.id, "report"]);
      assert.match(text, /TokenPilot report:/);
      assert.match(text, /sess-report/);
    });
    it("C8 the env override selects the config file", async () => {
      const { configPath } = await isolate(host);
      await dispatchCli([host.id, "mode", "conservative"]);
      assert.equal((await readConfig(configPath)).reduction.maxToolChars, 1800);
    });
  });
}
