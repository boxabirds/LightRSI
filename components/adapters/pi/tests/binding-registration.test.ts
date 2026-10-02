/**
 * Regression matrix: pi/src/preset.ts + pi/src/product-registration.ts + config paths
 *
 *   B1 host binding: hostId "pi", TokenPilot preset id/version, features exactly
 *      [stabilizer, reduction, eviction]; initializing the preset does not throw
 *   B2 product registration: hostId, display name, binding equal to the declared one
 *   B3 resolveStateDir honours an explicit product config path, else the default
 *   P1 default paths derive from PI_CODING_AGENT_DIR; TOKENPILOT_PI_CONFIG overrides the config
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TOKENPILOT_PRESET_ID, TOKENPILOT_PRESET_VERSION } from "@lightrsi/tokenpilot";

import { defaultPiExtensionDir, defaultPiStateDir, defaultTokenPilotPiConfigPath } from "../src/config.js";
import { PI_TOKENPILOT_HOST_BINDING, initializePiTokenPilotPreset, piSupportsEviction } from "../src/preset.js";
import { PI_PRODUCT_HOST_REGISTRATION } from "../src/product-registration.js";

describe("pi binding and registration", () => {
  it("B1 host binding declares the supported subset", () => {
    assert.equal(PI_TOKENPILOT_HOST_BINDING.hostId, "pi");
    assert.equal(PI_TOKENPILOT_HOST_BINDING.presetId, TOKENPILOT_PRESET_ID);
    assert.equal(PI_TOKENPILOT_HOST_BINDING.presetVersion, TOKENPILOT_PRESET_VERSION);
    assert.deepEqual(PI_TOKENPILOT_HOST_BINDING.supportedFeatures, ["stabilizer", "reduction", "eviction"]);
    assert.equal(piSupportsEviction(), true);
    assert.doesNotThrow(() => initializePiTokenPilotPreset());
  });
  it("B2 product registration", () => {
    assert.equal(PI_PRODUCT_HOST_REGISTRATION.hostId, "pi");
    assert.equal(PI_PRODUCT_HOST_REGISTRATION.displayName, "pi");
    assert.deepEqual(PI_PRODUCT_HOST_REGISTRATION.preset, PI_TOKENPILOT_HOST_BINDING);
  });
  it("B3 resolveStateDir uses the product config path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-pi-reg-"));
    const configPath = join(dir, "tokenpilot.json");
    await writeFile(configPath, JSON.stringify({ stateDir: join(dir, "custom-state") }));
    assert.equal(await PI_PRODUCT_HOST_REGISTRATION.resolveStateDir({ productConfigPath: configPath }), join(dir, "custom-state"));
  });
  it("P1 default paths follow PI_CODING_AGENT_DIR and TOKENPILOT_PI_CONFIG", () => {
    const saved = { agent: process.env.PI_CODING_AGENT_DIR, cfg: process.env.TOKENPILOT_PI_CONFIG };
    try {
      process.env.PI_CODING_AGENT_DIR = "/agents/pi";
      delete process.env.TOKENPILOT_PI_CONFIG;
      assert.equal(defaultTokenPilotPiConfigPath(), "/agents/pi/tokenpilot.json");
      assert.equal(defaultPiStateDir(), "/agents/pi/tokenpilot-state/tokenpilot");
      assert.equal(defaultPiExtensionDir(), "/agents/pi/extensions/tokenpilot");
      process.env.TOKENPILOT_PI_CONFIG = "/cfg/tp.json";
      assert.equal(defaultTokenPilotPiConfigPath(), "/cfg/tp.json");
      assert.equal(defaultPiStateDir(), "/cfg/tokenpilot-state/tokenpilot");
    } finally {
      if (saved.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.agent;
      if (saved.cfg === undefined) delete process.env.TOKENPILOT_PI_CONFIG; else process.env.TOKENPILOT_PI_CONFIG = saved.cfg;
    }
  });
});
