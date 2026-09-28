# pi

The pi integration is an **in-process extension**. TokenPilot runs inside [pi](https://pi.dev)'s own request lifecycle, so there is no proxy or gateway, and no pi-owned config file is modified. Verified on pi `0.87.1`.

## Installation

```bash
pnpm install
npm --prefix components/adapters/pi run build
npm --prefix components/products/cli run build
npm --prefix components/adapters/pi run install:pi
```

This command:

- writes a marker-tagged loader at `~/.pi/agent/extensions/tokenpilot/index.js`, backing up any foreign file at that path
- writes `~/.pi/agent/tokenpilot.json` in `normal` mode if it does not exist (never credentials)
- installs the `lightrsi` launcher

`PI_CODING_AGENT_DIR` and `TOKENPILOT_PI_CONFIG` override the locations. Remove with `npm --prefix components/adapters/pi run uninstall:pi` (add `-- --purge` to also delete the created config and state).

## How it works

| TokenPilot feature | pi hook |
| :-- | :-- |
| Stable prefix | `before_agent_start`: volatile prompt lines move to a trailing `tokenpilot_dynamic` section, so pi appends a section delta instead of replacing the prompt |
| Reduction | `context`: request-time, over the whole history |
| Recovery | native `memory_fault_recover` tool (pi has no MCP), same schema as the shared MCP tool |
| Eviction (opt-in) | `turn_end` → native `context_edit` entries, committed before pi's threshold compaction |

## Verification

1. Start pi (or `/reload`).
2. `lightrsi pi doctor`
3. After a few turns: `lightrsi pi report` or `lightrsi pi visual`

## Commands

```bash
lightrsi pi status | report | doctor | visual
lightrsi pi mode conservative|normal
lightrsi pi stabilizer on|off|target developer|user
lightrsi pi reduction on|off|pass <name> on|off
lightrsi pi eviction status|on|off|set minBlockChars <n>
```

## Troubleshooting

- Hook failures never break pi. They are logged to `~/.pi/agent/tokenpilot-state/tokenpilot/tokenpilot/adapter.log`.
- `eviction: inactive (estimator_incomplete)` in `doctor` means `taskStateEstimator.baseUrl`, `model` or `apiKey` is missing.

See the [adapter README](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/pi/README.md) and the [design note](https://github.com/zjunlp/LightRSI/blob/main/docs/adapters/pi-design.md).
