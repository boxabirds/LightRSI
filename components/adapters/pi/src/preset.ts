import {
  createTokenPilotHostBinding,
  initializeTokenPilotPreset,
} from "@lightrsi/tokenpilot";

export const PI_TOKENPILOT_HOST_BINDING = createTokenPilotHostBinding({
  hostId: "pi",
  supportedFeatures: ["stabilizer", "reduction", "eviction"],
});

export function initializePiTokenPilotPreset(): void {
  initializeTokenPilotPreset(PI_TOKENPILOT_HOST_BINDING);
}

export function piSupportsEviction(): boolean {
  return PI_TOKENPILOT_HOST_BINDING.supportedFeatures.includes("eviction");
}
