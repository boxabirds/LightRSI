/**
 * OpenCode v1 plugin entry (`~/.config/opencode/plugins/tokenpilot.js` loads this).
 *
 * OpenCode reads `default` as `{ id, server }` (`plugin/shared.ts` `readV1Plugin`).
 * Only the default export exists: OpenCode's legacy loader would reject any other
 * non-function export.
 */
import type { OcPluginModule } from "./opencode-types.js";
import { OpenCodeTokenPilotRuntime } from "./runtime.js";

const plugin: OcPluginModule = {
  id: "tokenpilot",
  async server() {
    return new OpenCodeTokenPilotRuntime().hooks();
  },
};

export default plugin;
