# Plugin Lifecycle

No formal plugin lifecycle specification exists. TokenPilot uses host-specific mechanisms:

- **OpenClaw**: native plugin slot with bundled runtime
- **Codex CLI**: hooks (`SessionStart`, `PreToolUse`, `PostToolUse`) via `hooks.json`
- **Claude Code**: `SessionStart` hook + gateway + MCP recovery
- **DeepSeek Harness**: native Cordis plugin (`tokenpilot-dsh`); opt-in eviction runs in `agent/pre-step` before native compaction by default
- **pi**: in-process extension (`before_agent_start`, `context`, `turn_end`) with a native `memory_fault_recover` tool
- **OpenCode**: in-process v1 plugin (`experimental.chat.system.transform`, `experimental.chat.messages.transform`) + recovery MCP registered in `opencode.json`

## Next

- [Configuration Model](/platform-concepts/configuration-model) — how plugin config works
- [Runtime API](/plugin-development/runtime-api) — the plugin programming interface
