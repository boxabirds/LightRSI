import { readLatestUxEffect } from "@lightrsi/host-adapter";
import { defineProductHostRegistration } from "@lightrsi/product-surface";
import { defaultTokenPilotOpenCodeConfigPath, loadTokenPilotOpenCodeConfig } from "./config.js";
import { OPENCODE_TOKENPILOT_HOST_BINDING } from "./preset.js";

export const OPENCODE_PRODUCT_HOST_REGISTRATION = defineProductHostRegistration({
  hostId: "opencode",
  displayName: "OpenCode",
  preset: OPENCODE_TOKENPILOT_HOST_BINDING,
  async resolveStateDir(context) {
    const config = await loadTokenPilotOpenCodeConfig(
      context?.productConfigPath?.trim() || defaultTokenPilotOpenCodeConfigPath(),
    );
    return config.stateDir;
  },
  readLatestActivity: readLatestUxEffect,
});
