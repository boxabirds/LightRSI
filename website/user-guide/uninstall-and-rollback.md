# Uninstall and Rollback

How to stop TokenPilot and restore your original configuration.

## Quick Rollback

The OpenClaw, Codex, and Claude Code installers create `.tokenpilot.bak` backups for the host configuration files they preserve. Restore the applicable backup to its original name.

## pi and OpenCode

The pi and OpenCode adapters use their own package uninstall commands rather than the `.tokenpilot.bak` workflow. For pi, `npm --prefix components/adapters/pi run uninstall:pi` removes the extension loader and restores any loader file it backed up; add `-- --purge` to also delete the created config and state. For OpenCode, `npm --prefix components/adapters/opencode run uninstall:opencode` removes the plugin loader and exactly the `mcp.tokenpilot_memory_fault_recover` entry it added; add `-- --purge` to also delete the created config and state. See the [pi](/hosts/pi) and [OpenCode](/hosts/opencode) host guides.

## DeepSeek Harness

DeepSeek Harness uses its own Cordis profile installation. The `.tokenpilot.bak` workflow above does not apply. To stop the adapter's automatic eviction, set `eviction.enabled` to `false` in its profile configuration, or set the plugin's `enabled` to `false` to disable its eviction handler. Reload the configured profile. This stops future changes; it does not undo prior replacements. See [DeepSeek Harness configuration](/hosts/deepseek-harness#configure-and-enable).

## Next

- [Install LightRSI](/getting-started/install-lightrsi) — fresh install
- [Troubleshooting](/plugin-catalog/tokenpilot/troubleshooting) — problems before uninstalling
