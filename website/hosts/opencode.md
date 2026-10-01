# OpenCode

The OpenCode integration is an **in-process v1 plugin** plus the shared recovery MCP server registered in OpenCode's own config. Verified on OpenCode `1.18.33`.

## Installation

```bash
pnpm install
pnpm --filter @lightrsi/mcp build
npm --prefix components/adapters/opencode run build
npm --prefix components/products/cli run build
npm --prefix components/adapters/opencode run install:opencode
```

This command, in `~/.config/opencode` (or `$XDG_CONFIG_HOME/opencode`):

- writes a marker-tagged ESM loader at `plugins/tokenpilot.js`
- adds `mcp.tokenpilot_memory_fault_recover` to `opencode.json` after writing a timestamped backup. An `opencode.jsonc`-only setup is never rewritten; the snippet is printed instead.
- writes `tokenpilot.json` in `normal` mode if it does not exist (never credentials)

Remove with `npm --prefix components/adapters/opencode run uninstall:opencode`. It removes exactly what install added.

## How it works

| TokenPilot feature | OpenCode hook |
| :-- | :-- |
| Stable prefix | `experimental.chat.system.transform` (volatile lines moved to the tail; `developer` target only) |
| Reduction | `experimental.chat.messages.transform`, before every model step |
| Recovery | shared recovery MCP server (`tokenpilot_memory_fault_recover_memory_fault_recover` in OpenCode) |
| Eviction (opt-in) | `experimental.chat.messages.transform` + a durable per-session overlay |

OpenCode's native tool-output pruning (`compaction.prune`) is off by default in 1.18.33. TokenPilot never changes it, and `doctor` reports its current value.

## Verification

1. Restart OpenCode.
2. `lightrsi opencode doctor`: loader, bundle and MCP entry present, MCP probe `ok`.
3. After a few turns: `lightrsi opencode report`

## Troubleshooting

- OpenCode does not catch plugin errors; TokenPilot catches its own and logs to `~/.config/opencode/tokenpilot-state/tokenpilot/tokenpilot/adapter.log`.
- `opencode run --pure "…"` runs without plugins for comparison.

See the [adapter README](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/opencode/README.md) and the [design note](https://github.com/zjunlp/LightRSI/blob/main/docs/adapters/opencode-design.md).
