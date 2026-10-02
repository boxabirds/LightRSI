import { readLatestUxEffect } from "@lightrsi/host-adapter";
import { defineProductHostRegistration } from "@lightrsi/product-surface";
import { defaultTokenPilotPiConfigPath, loadTokenPilotPiConfig } from "./config.js";
import { PI_TOKENPILOT_HOST_BINDING } from "./preset.js";

export const PI_PRODUCT_HOST_REGISTRATION = defineProductHostRegistration({
  hostId: "pi",
  displayName: "pi",
  preset: PI_TOKENPILOT_HOST_BINDING,
  async resolveStateDir(context) {
    const config = await loadTokenPilotPiConfig(
      context?.productConfigPath?.trim() || defaultTokenPilotPiConfigPath(),
    );
    return config.stateDir;
  },
  readLatestActivity: readLatestUxEffect,
});
