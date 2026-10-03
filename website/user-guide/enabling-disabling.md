# Enabling and Disabling Plugins

TokenPilot is enabled per host. There is no shared `plugin <name> enable` action: you turn the runtime on or off through the host's own configuration and the shared per-subsystem commands.

## Per-Subsystem Toggles

These commands are available on every host with a shared-CLI surface (`openclaw`, `codex`, `claude-code`, `pi`, `opencode`):

```bash
lightrsi <host> stabilizer on|off
lightrsi <host> reduction on|off
lightrsi <host> mode <conservative|normal>
```

Lifecycle eviction is opt-in and off by default. Only the adapters that expose eviction controls provide these commands:

```bash
lightrsi openclaw eviction on|off
lightrsi pi eviction on|off
lightrsi opencode eviction on|off
lightrsi opencode eviction set minBlockChars <number>
```

- Codex enables automatic eviction through configuration rather than a command:
  set `taskStateEstimator.enabled` and `contextRewrite.enabled` in
  `~/.codex/tokenpilot.json`.
- Claude Code implements stable prefix and reduction only.
- DeepSeek Harness is configured through its profile patch instead of the shared
  CLI; see [DeepSeek Harness](/hosts/deepseek-harness#configure-and-enable).

Subsystem changes apply to subsequent requests.

## Master Switch

To turn TokenPilot off entirely, set the master switch in the host's TokenPilot configuration. With `enabled` set to `false`, every hook becomes a no-op while the adapter stays installed:

| Host | Master switch |
| :-- | :-- |
| OpenClaw | `plugins.entries.tokenpilot.enabled` in `~/.openclaw/openclaw.json` |
| Codex CLI | `enabled` in `~/.codex/tokenpilot.json` |
| Claude Code | `enabled` in `~/.claude/tokenpilot.json` |
| pi | `enabled` in `~/.pi/agent/tokenpilot.json` |
| OpenCode | `enabled` in `~/.config/opencode/tokenpilot.json` |
| DeepSeek Harness | top-level `enabled` in the `tokenpilot-dsh` profile patch |

OpenClaw reads its plugin entry when the gateway starts, so restart the gateway after changing that flag. For DeepSeek Harness, reload the configured profile; disabling it stops future execution but does not undo changes already applied.

## When to Disable

- **Debugging unexpected model behavior**: rule out plugin interference
- **Short sessions**: plugin overhead may not justify the savings
- **Testing**: compare with and without TokenPilot

## Check Current State

```bash
lightrsi status            # latest available report across hosts
lightrsi <host> status     # one host: config, mode, and module state
```

For a deeper self-check, run `lightrsi <host> doctor`. To remove a host integration entirely, see [Uninstall and Rollback](/user-guide/uninstall-and-rollback).

## Next

- [Plugin Configuration](/user-guide/plugin-configuration) — per-plugin settings
- [Sessions](/user-guide/sessions) — session management
