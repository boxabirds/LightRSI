import {
  createTokenPilotHostBinding,
  initializeTokenPilotPreset,
} from "@lightrsi/tokenpilot";

export const OPENCODE_TOKENPILOT_HOST_BINDING = createTokenPilotHostBinding({
  hostId: "opencode",
  supportedFeatures: ["stabilizer", "reduction", "eviction"],
});

export function initializeOpenCodeTokenPilotPreset(): void {
  initializeTokenPilotPreset(OPENCODE_TOKENPILOT_HOST_BINDING);
}

export function openCodeSupportsEviction(): boolean {
  return OPENCODE_TOKENPILOT_HOST_BINDING.supportedFeatures.includes("eviction");
}
