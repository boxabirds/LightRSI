# Metrics and Observability

TokenPilot provides the following observability surfaces from the source repository:

- `lightrsi report` — shows the latest available report across hosts
- `lightrsi visual` — opens the shared browser visual and lets you switch hosts and sessions
- `lightrsi <host> doctor` — adapter self-check

Runtime state files are persisted under host-specific state directories:

| File | Description |
| :-- | :-- |
| `ux-effects/latest.json` | Latest session runtime effects |
| `ux-effects/sessions/<session>.json` | Per-session effect history |
| `event-trace.jsonl` | Stream of runtime events |
| `session-state/latest.json` | Current session state snapshot |

State roots by host:
- OpenClaw: `~/.openclaw/tokenpilot-plugin-state/tokenpilot/`
- Codex CLI: `~/.codex/tokenpilot-state/tokenpilot/`
- Claude Code: `~/.claude/tokenpilot-state/tokenpilot/`
- pi: `~/.pi/agent/tokenpilot-state/tokenpilot/`
- OpenCode: `~/.config/opencode/tokenpilot-state/tokenpilot/`

## Related Pages

- [TokenPilot Reports and Visuals](/plugin-catalog/tokenpilot/reports-and-visuals) — detailed documentation of TokenPilot's observability surfaces
- [Runtime API](/plugin-development/runtime-api) — the shared packages and event types used for metrics collection
