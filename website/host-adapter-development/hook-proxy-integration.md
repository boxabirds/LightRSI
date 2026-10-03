# Hook and Proxy Integration

TokenPilot uses four integration patterns across its six host adapters: proxy + hooks, gateway + MCP, native plugin slot, and fully in-process extensions.

## Integration Approaches

### Proxy + Hooks (Codex CLI)

From [HOSTS.md](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/HOSTS.md): uses Codex config mutation, hook registration, and a local OpenAI-compatible Responses proxy. Preserves the current active Codex provider name and reroutes that provider's `base_url` through the local proxy. Hooks registered: `SessionStart`, `PreToolUse`, `PostToolUse`.

### Gateway + MCP + SessionStart (Claude Code)

From [HOSTS.md](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/HOSTS.md): uses local Anthropic-compatible gateway routing plus lightweight hooks for observability. A `SessionStart` hook auto-starts the local gateway. The `tokenpilot_memory_fault_recover` MCP server is registered for recovery.

### Native Plugin Slot (OpenClaw)

From [HOSTS.md](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/HOSTS.md): bundled plugin with embedded runtime. The host delivers events directly to the plugin without an external proxy or gateway. Supports in-host slash commands, lifecycle eviction controls, and `mode aggressive`.

### Cordis Plugin + Durable Projection (DeepSeek Harness)

From [HOSTS.md](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/HOSTS.md): a Cordis plugin adapter with durable session and event projection. Canonical-surface eviction is opt-in and guarded by estimator, registry, safety, and revision checks. Status is exposed through the native `/tokenpilot-status` command rather than the shared CLI.

### In-Process Extension (pi)

pi has an in-process extension API, so no proxy or gateway is involved and no pi-owned config file is changed. The adapter registers `before_agent_start` for the stable prefix, `context` for request-time reduction, and `turn_end` for opt-in eviction through native `context_edit` entries. Because pi has no MCP, recovery is exposed as a native `memory_fault_recover` tool with the shared tool's name, description, and schema.

### In-Process Plugin + MCP (OpenCode)

OpenCode loads the adapter as an in-process v1 plugin and takes the shared recovery MCP server from `opencode.json`. The plugin uses `experimental.chat.system.transform` for the stable prefix and `experimental.chat.messages.transform` for reduction and opt-in eviction, which runs before every model step. Evictions are stored per session as a durable overlay and re-applied identically on each request.

## Related Pages

- [Adapter Architecture](./adapter-architecture.md)
- [Adding a New Host](./adding-new-host.md)
- [Configuration Integration](./configuration-integration.md)
- [HOSTS.md](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/HOSTS.md)
