# Configuration Integration

## Config Files by Host

From source:

| Host | Config Location | Purpose |
| :-- | :-- | :-- |
| **OpenClaw** | Plugin entry in `~/.openclaw/openclaw.json` | TokenPilot registered as a plugin within OpenClaw configuration |
| **Codex CLI** | `~/.codex/tokenpilot.json` (runtime config) + `~/.codex/hooks.json` (hook registration) | `tokenpilot.json` stores provider config and runtime settings. `hooks.json` registers hooks (`SessionStart`, `PreToolUse`, `PostToolUse`). Host's `config.toml` modified to reroute provider `base_url` to local proxy |
| **Claude Code** | `~/.claude/tokenpilot.json` (runtime config) + `~/.claude/settings.json` (gateway routing) + `~/.claude/.claude.json` (MCP registration) | `tokenpilot.json` stores runtime config. `settings.json` updated for gateway routing. `.claude.json` registers `tokenpilot_memory_fault_recover` MCP server |
| **pi** | `~/.pi/agent/tokenpilot.json` (+ extension loader at `~/.pi/agent/extensions/tokenpilot/index.js`) | `tokenpilot.json` stores runtime config. The loader is the only file install writes; no pi-owned config file is modified |
| **OpenCode** | `~/.config/opencode/tokenpilot.json` (runtime config) + `~/.config/opencode/opencode.json` (recovery MCP registration) + `plugins/tokenpilot.js` (loader) | `tokenpilot.json` stores runtime config. `opencode.json` gains exactly one `mcp.tokenpilot_memory_fault_recover` entry, after a backup |
| **DeepSeek Harness** | Selected Harness profile's `cordis.patch.yml` | `tokenpilot-dsh` settings: master switch, durable `stateDir`, task-state estimator, eviction, and compaction ordering; see [configuration guide](/hosts/deepseek-harness#configure-and-enable) |

## Environment Variables

From source:

| Adapter | Environment Variable | Default Path |
| :-- | :-- | :-- |
| OpenClaw | `LIGHTRSI_OPENCLAW_HOME` | `~/.openclaw/` |
| OpenClaw | `OPENCLAW_CONFIG_PATH` | `~/.openclaw/openclaw.json` |
| Codex | `CODEX_CONFIG_PATH` | `~/.codex/config.toml` |
| Codex | `CODEX_HOOKS_CONFIG_PATH` | `~/.codex/hooks.json` |
| Codex | `TOKENPILOT_CODEX_CONFIG` | `~/.codex/tokenpilot.json` |
| Claude Code | `CLAUDE_CODE_SETTINGS_PATH` | `~/.claude/settings.json` |
| Claude Code | `CLAUDE_CODE_MCP_CONFIG_PATH` | `~/.claude/.claude.json` |
| Claude Code | `TOKENPILOT_CLAUDE_CODE_CONFIG` | `~/.claude/tokenpilot.json` |
| pi | `PI_CODING_AGENT_DIR` | `~/.pi/agent/` |
| pi | `TOKENPILOT_PI_CONFIG` | `~/.pi/agent/tokenpilot.json` |
| OpenCode | `TOKENPILOT_OPENCODE_CONFIG_DIR` | `~/.config/opencode/` |
| OpenCode | `TOKENPILOT_OPENCODE_CONFIG` | `~/.config/opencode/tokenpilot.json` |

## Backup Strategy

Before modifying existing host config files, the OpenClaw, Codex, and Claude Code installers create `.tokenpilot.bak` backups. This applies to Codex (`~/.codex/config.toml`) and Claude Code (`~/.claude/settings.json`, `~/.claude/.claude.json`). The pi installer modifies no pi-owned file; the OpenCode installer writes a timestamped backup before adding its single MCP entry, and leaves a non-plain-JSON `opencode.json` or an `opencode.jsonc` untouched.

## Related Pages

- [Adapter Architecture](./adapter-architecture.md)
- [Adding a New Host](./adding-new-host.md)
- [Hook and Proxy Integration](./hook-proxy-integration.md)
- [TokenPilot Configuration](https://github.com/zjunlp/LightRSI/blob/main/README.md)
