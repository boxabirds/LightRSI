# Install Your First Plugin

After [installing LightRSI](/getting-started/install-lightrsi), install the integration for your host. TokenPilot is the context-management preset; Context Cleaner is the user-facing task cleanup product. Native host plugins, proxies, and gateways connect these capabilities to each host.

The commands below install the host integration. Cleaner entrypoints and apply timing vary by host; see [Context Cleaner](/user-guide/context-cleaner#supported-hosts).

## Install TokenPilot

Pick your host:

### OpenClaw

```bash
pnpm component:install:tokenpilot:openclaw
```

This command:
- Builds one release archive containing the OpenClaw plugin and bundled `lightrsi` CLI
- Installs the CLI in `~/.local/bin` by default, or in `LIGHTRSI_BIN_DIR` when set
- Updates `~/.openclaw/openclaw.json`
- Enables the TokenPilot plugin
- Switches `plugins.slots.contextEngine` to `tokenpilot`
- Applies the default `normal` mode settings
- Attempts to restart the OpenClaw gateway

**Custom paths:**

```bash
export LIGHTRSI_OPENCLAW_HOME="/path/to/openclaw-home"
export OPENCLAW_CONFIG_PATH="/path/to/openclaw.json"
pnpm component:install:tokenpilot:openclaw
```

### Codex

```bash
corepack pnpm cleaner:install:codex
```

This command:
- Reroutes your active Codex provider through the local TokenPilot proxy
- Writes `~/.codex/tokenpilot.json`
- Registers hooks in `~/.codex/hooks.json`
- Registers the shared `tokenpilot_memory_fault_recover` MCP server
- Builds and installs the shared `lightrsi` CLI and the explicit-only `lightrsi-clean`, `lightrsi-clean-status`, `lightrsi-clean-apply`, and `lightrsi-clean-cancel` skills

**Custom paths:**

```bash
export CODEX_CONFIG_PATH="/path/to/config.toml"
export CODEX_HOOKS_CONFIG_PATH="/path/to/hooks.json"
export TOKENPILOT_CODEX_CONFIG="/path/to/tokenpilot.json"
corepack pnpm cleaner:install:codex
```

### Claude Code

```bash
corepack pnpm cleaner:install:claude-code
```

This command:
- Updates `~/.claude/settings.json` for local gateway routing
- Writes `~/.claude/tokenpilot.json`
- Registers the shared `tokenpilot_memory_fault_recover` MCP server
- Installs a `SessionStart` hook that auto-starts the gateway
- Backs up existing Claude files as `.tokenpilot.bak`
- Builds and installs the shared `lightrsi` CLI and the explicit-only Cleaner analysis, status, apply, and cancel skills

**Custom paths:**

```bash
export CLAUDE_CODE_SETTINGS_PATH="/path/to/settings.json"
export CLAUDE_CODE_MCP_CONFIG_PATH="/path/to/.claude.json"
export TOKENPILOT_CLAUDE_CODE_CONFIG="/path/to/tokenpilot.json"
corepack pnpm cleaner:install:claude-code
```

### pi

```bash
npm --prefix components/adapters/pi run build
npm --prefix components/adapters/pi run install:pi
```

This command:
- Writes a marker-tagged loader at `~/.pi/agent/extensions/tokenpilot/index.js`
- Writes `~/.pi/agent/tokenpilot.json` in `normal` mode if it does not exist
- Registers a native `memory_fault_recover` tool (pi has no MCP)
- Installs the shared `lightrsi` CLI
- Modifies no pi-owned config file and runs no proxy or gateway

**Custom paths:**

```bash
export PI_CODING_AGENT_DIR="/path/to/pi-agent-dir"
export TOKENPILOT_PI_CONFIG="/path/to/tokenpilot.json"
npm --prefix components/adapters/pi run install:pi
```

### OpenCode

```bash
npm --prefix components/adapters/opencode run build
npm --prefix components/adapters/opencode run install:opencode
```

This command:
- Writes a marker-tagged loader at `~/.config/opencode/plugins/tokenpilot.js`
- Adds the shared recovery MCP server to `opencode.json`
- Writes `~/.config/opencode/tokenpilot.json` in `normal` mode if it does not exist
- Installs the shared `lightrsi` CLI
- Runs no proxy or gateway

**Custom paths:**

```bash
export TOKENPILOT_OPENCODE_CONFIG_DIR="/path/to/opencode-config-dir"
export TOKENPILOT_OPENCODE_CONFIG="/path/to/tokenpilot.json"
npm --prefix components/adapters/opencode run install:opencode
```

### DeepSeek Harness

Build and package the adapter from the LightRSI repository:

```bash
corepack pnpm --filter @lightrsi/deepseek-harness-adapter build
corepack pnpm --filter @lightrsi/deepseek-harness-adapter pack --pack-destination ./artifacts
```

Then, from your DeepSeek Harness checkout, install the generated archive into your profile:

```bash
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add /absolute/path/to/lightrsi-deepseek-harness-adapter-<version>.tgz
```

Replace the archive path and profile as needed. The plugin is registered as `tokenpilot-dsh` and remains disabled until you configure and enable it. Supply a durable `stateDir` and the estimator and eviction settings described in [DeepSeek Harness Configuration](/hosts/deepseek-harness#configure-and-enable).

## Verify Installation

For OpenClaw, Codex, Claude Code, pi, and OpenCode:

```bash
lightrsi doctor
```

Or check per-host:

```bash
lightrsi openclaw doctor
lightrsi openclaw clean --help
lightrsi codex doctor
lightrsi claude-code doctor
lightrsi codex clean --help
lightrsi claude-code clean --help
lightrsi pi doctor
lightrsi opencode doctor
```

Look for: `plugin entry enabled`, `config enabled`, `proxy healthy: yes`. Only OpenClaw, Codex, and Claude Code run a local proxy or gateway, so `proxy healthy` does not apply to pi or OpenCode.

For DeepSeek Harness, open a session with the configured profile and run:

```text
/tokenpilot-status
```

This reports estimator, scheduling, application, and deferral state without creating a model turn. It is the Harness verification entrypoint rather than a shared CLI `doctor` command.

## What Changed

Installation and configuration locations differ by host:

| Host | Configuration Location |
| :-- | :-- |
| OpenClaw | `~/.openclaw/openclaw.json` |
| Codex | `~/.codex/tokenpilot.json`, `~/.codex/hooks.json` |
| Claude Code | `~/.claude/settings.json`, `~/.claude/tokenpilot.json`, `~/.claude/.claude.json` |
| DeepSeek Harness | `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (default home: `~/.dsh`); [profile setup](/hosts/deepseek-harness#configure-and-enable) |
| pi | `~/.pi/agent/tokenpilot.json` |
| OpenCode | `~/.config/opencode/tokenpilot.json`, `~/.config/opencode/opencode.json` |

The OpenClaw, Codex, and Claude Code installers preserve the host configuration files they back up as `.tokenpilot.bak`. The pi installer modifies no pi-owned file. The OpenCode installer backs up `opencode.json` before adding only the recovery MCP entry, and leaves a non-plain-JSON `opencode.json` or an `opencode.jsonc` untouched so your comments survive. DeepSeek Harness uses its own profile plugin installer; do not assume the same backup convention.

## Next

- [Context Cleaner](/user-guide/context-cleaner) — inspect tasks, approve a clean, and verify its receipt
- [Runtime Modes](/plugin-catalog/tokenpilot/runtime-modes) — choose your risk/aggressiveness level
- [CLI Reference](/user-guide/cli-reference) — all available commands
- [Troubleshooting](/plugin-catalog/tokenpilot/troubleshooting) — common install issues
