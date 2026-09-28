/**
 * Regression matrix: opencode/src/preset.ts + product-registration.ts + config paths
 *
 *   B1 host binding: hostId "opencode", TokenPilot preset id/version, features exactly
 *      [stabilizer, reduction, eviction]; initializing the preset does not throw
 *   B2 product registration: hostId, display name, binding equal to the declared one
 *   B3 resolveStateDir honours an explicit product config path
 *   P1 config dir: TOKENPILOT_OPENCODE_CONFIG_DIR > $XDG_CONFIG_HOME/opencode > ~/.config/opencode;
 *      TOKENPILOT_OPENCODE_CONFIG overrides the config file
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TOKENPILOT_PRESET_ID, TOKENPILOT_PRESET_VERSION } from "@lightrsi/tokenpilot";

import { defaultOpenCodeConfigDir, defaultOpenCodeStateDir, defaultTokenPilotOpenCodeConfigPath } from "../src/config.js";
import { OPENCODE_TOKENPILOT_HOST_BINDING, initializeOpenCodeTokenPilotPreset, openCodeSupportsEviction } from "../src/preset.js";
import { OPENCODE_PRODUCT_HOST_REGISTRATION } from "../src/product-registration.js";

describe("opencode binding and registration", () => {
  it("B1 host binding declares the supported subset", () => {
    assert.equal(OPENCODE_TOKENPILOT_HOST_BINDING.hostId, "opencode");
    assert.equal(OPENCODE_TOKENPILOT_HOST_BINDING.presetId, TOKENPILOT_PRESET_ID);
    assert.equal(OPENCODE_TOKENPILOT_HOST_BINDING.presetVersion, TOKENPILOT_PRESET_VERSION);
    assert.deepEqual(OPENCODE_TOKENPILOT_HOST_BINDING.supportedFeatures, ["stabilizer", "reduction", "eviction"]);
    assert.equal(openCodeSupportsEviction(), true);
    assert.doesNotThrow(() => initializeOpenCodeTokenPilotPreset());
  });
  it("B2 product registration", () => {
    assert.equal(OPENCODE_PRODUCT_HOST_REGISTRATION.hostId, "opencode");
    assert.equal(OPENCODE_PRODUCT_HOST_REGISTRATION.displayName, "OpenCode");
    assert.deepEqual(OPENCODE_PRODUCT_HOST_REGISTRATION.preset, OPENCODE_TOKENPILOT_HOST_BINDING);
  });
  it("B3 resolveStateDir uses the product config path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-oc-reg-"));
    const configPath = join(dir, "tokenpilot.json");
    await writeFile(configPath, JSON.stringify({ stateDir: join(dir, "custom-state") }));
    assert.equal(await OPENCODE_PRODUCT_HOST_REGISTRATION.resolveStateDir({ productConfigPath: configPath }), join(dir, "custom-state"));
  });
  it("P1 config dir precedence", () => {
    const keys = ["TOKENPILOT_OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "HOME", "TOKENPILOT_OPENCODE_CONFIG"] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const k of keys) delete process.env[k];
      process.env.HOME = "/home/u";
      assert.equal(defaultOpenCodeConfigDir(), "/home/u/.config/opencode");
      process.env.XDG_CONFIG_HOME = "/xdg";
      assert.equal(defaultOpenCodeConfigDir(), "/xdg/opencode");
      process.env.TOKENPILOT_OPENCODE_CONFIG_DIR = "/override";
      assert.equal(defaultOpenCodeConfigDir(), "/override");
      assert.equal(defaultTokenPilotOpenCodeConfigPath(), "/override/tokenpilot.json");
      assert.equal(defaultOpenCodeStateDir(), "/override/tokenpilot-state/tokenpilot");
      process.env.TOKENPILOT_OPENCODE_CONFIG = "/cfg/tp.json";
      assert.equal(defaultTokenPilotOpenCodeConfigPath(), "/cfg/tp.json");
    } finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  });
});
