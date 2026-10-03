# Lifecycle Hooks

TokenPilot implements host-specific lifecycle hooks through its adapters. The actual hooks available depend on the host:

| Host | Hooks Used |
| :-- | :-- |
| OpenClaw | native plugin slot: layered context engine, tool-call hooks, and tool-result persistence (no external hook registration) |
| Codex CLI | `SessionStart`, `PreToolUse`, `PostToolUse` (registered in `hooks.json`) |
| Claude Code | `SessionStart` (auto-starts gateway) |
| pi | `before_agent_start` (stable prefix), `context` (reduction), `turn_end` (opt-in eviction) |
| OpenCode | `experimental.chat.system.transform` (stable prefix), `experimental.chat.messages.transform` (reduction and opt-in eviction) |
| DeepSeek Harness | Cordis plugin lifecycle; status is reported through `/tokenpilot-status` |

These are host-specific hook names used by TokenPilot adapters, not a universal lifecycle specification. No formal lifecycle hook specification exists for the platform.

The shared runtime logic lives in `components/packages/foundation/runtime-core/`, while the hook wiring lives in `components/adapters/<host>/src/`.

## Related Pages

- [Host-Independent Design](/plugin-development/host-independent-design) — keeping shared logic separate from host-specific hook wiring
- [Hook and Proxy Integration](/host-adapter-development/hook-proxy-integration)
- [Adapter Architecture](/host-adapter-development/adapter-architecture)
