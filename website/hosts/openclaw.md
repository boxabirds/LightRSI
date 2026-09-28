# OpenClaw

OpenClaw is the primary host for LightRSI, with the deepest integration via a native plugin slot.

## Installation

```bash
pnpm component:install:tokenpilot:openclaw
```

This command:
- Builds one release archive containing the plugin and bundled `lightrsi` CLI
- Installs the CLI in `~/.local/bin` by default, or in `LIGHTRSI_BIN_DIR` when set
- Updates `~/.openclaw/openclaw.json`
- Enables the TokenPilot plugin
- Switches `plugins.slots.contextEngine` to `layered-context`
- Sets the default `normal` mode
- Attempts to restart the OpenClaw gateway

### Custom Paths

```bash
export LIGHTRSI_OPENCLAW_HOME="/path/to/openclaw-home"
export OPENCLAW_CONFIG_PATH="/path/to/openclaw.json"
pnpm component:install:tokenpilot:openclaw
```

## Expected Output

After install, your `~/.openclaw/openclaw.json` will include a TokenPilot section:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "layered-context"
    },
    "entries": {
      "tokenpilot": {
        "enabled": true,
        "mode": "normal"
      }
    }
  }
}
```

## Verification

Inside an OpenClaw session:

```text
/lightrsi status
```

Expected output:
- `plugin entry enabled`
- `config enabled`
- `mode normal`
- `context engine slot layered-context`
- `stabilizer enabled`
- `reduction enabled`

For a fuller check:

```text
/lightrsi doctor
/lightrsi report
/lightrsi visual
```

## In-Session Commands

OpenClaw supports in-session slash commands:

```text
/lightrsi status          # View current status
/lightrsi report          # Session token/cost report
/lightrsi doctor          # Integration self-check
/lightrsi visual          # Open visual inspector
/lightrsi mode normal     # Switch mode
/lightrsi stabilizer target developer
/lightrsi reduction mode balanced
/lightrsi eviction on
/lightrsi help            # List all commands
```

## Standalone CLI

Commands also work outside OpenClaw:

```bash
lightrsi openclaw status
lightrsi openclaw report
lightrsi openclaw doctor
lightrsi openclaw visual
lightrsi openclaw mode normal
lightrsi openclaw session <session-id> report
lightrsi openclaw clean --require-tty --session <session-id>
```

## Model Selection

```text
lightrsi/gpt-5.4-mini
```

## Context Cleaner

Analyze the current mapped conversation without rewriting its context:

```text
/lightrsi clean
```

If the session cannot be resolved, use `/lightrsi clean --session <session-id>`. Review the returned plan and select only eligible task IDs:

```text
/lightrsi clean --plan <plan-id> --select <task-id-1>,<task-id-2>
/lightrsi clean --status <plan-id>
/lightrsi clean --cancel <plan-id>
```

`/tokenpilot clean` and `/tp clean` are aliases. When selectable tasks exist, native analysis prints `lightrsi openclaw clean --require-tty --session <current-session-id>`. Return to the shell that launched OpenClaw and run that exact command to open the shared selector: Up/Down moves, Space toggles, Enter submits, and `q` cancels. The explicit session ID binds the selector to the current conversation; no recent-session guess is used. The native command itself returns a text plan and does not take over OpenClaw's keyboard.

Explicit approval returns `scheduled` without changing the canonical transcript. Return to OpenClaw and send the next ordinary message to execute the plan, then query `--status` for its result. During execution, the canonical eviction backend archives task content and commits the rewrite. The rewrite uses pointer stubs or drops selected content according to the replacement mode; cancelling a Cleaner plan does not undo an applied rewrite. Native commands and the CLI share plans and receipts.

See [Context Cleaner](/user-guide/context-cleaner) for task protection, accounting, and cancellation limits.

## Recovery

```bash
cp ~/.openclaw/openclaw.json.tokenpilot.bak ~/.openclaw/openclaw.json
```

## Troubleshooting

See [TokenPilot Troubleshooting](/plugin-catalog/tokenpilot/troubleshooting#openclaw) for OpenClaw-specific issues.
