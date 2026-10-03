/**
 * pi extension entry point (`~/.pi/agent/extensions/tokenpilot/index.js` loads this).
 *
 * The factory only registers handlers and the recovery tool. Config, state roots
 * and caches are set up in `session_start`, as pi's extension contract requires
 * (no long-lived resources in the factory).
 */
import type { PiExtensionAPI } from "./pi-types.js";
import { PiTokenPilotRuntime, type PiRuntimeDependencies } from "./runtime.js";

export function registerTokenPilotPiExtension(pi: PiExtensionAPI, deps?: PiRuntimeDependencies): PiTokenPilotRuntime {
  const runtime = new PiTokenPilotRuntime(deps);
  pi.on("session_start", (event, ctx) => runtime.onSessionStart(event, ctx));
  pi.on("session_shutdown", () => runtime.onSessionShutdown());
  pi.on("before_agent_start", (event, ctx) => runtime.onBeforeAgentStart(event, ctx));
  pi.on("context", (event, ctx) => runtime.onContext(event, ctx));
  pi.on("turn_end", (event, ctx) => runtime.onTurnEnd(event, ctx));
  pi.registerTool(runtime.recoveryTool());
  return runtime;
}

export default function tokenPilotPiExtension(pi: PiExtensionAPI): void {
  registerTokenPilotPiExtension(pi);
}
