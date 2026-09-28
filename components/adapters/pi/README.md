# TokenPilot pi Adapter

This package integrates TokenPilot with [pi](https://pi.dev) (`@earendil-works/pi-coding-agent`, verified on **0.87.1**) as an in-process pi extension. No proxy or gateway is involved: TokenPilot runs inside pi's own request lifecycle.

This adapter explicitly binds the TokenPilot `stabilizer`, `reduction`, and `eviction` features. Its product registration provides pi state discovery to the shared CLI and Visual surface.

Design, host facts and gaps: [`docs/adapters/pi-design.md`](../../../docs/adapters/pi-design.md).

For the component-level overview and shared command surface, see:

- [`components/presets/tokenpilot/README.md`](../../presets/tokenpilot/README.md)
- [`components/adapters/README.md`](../README.md)
- [`components/adapters/HOSTS.md`](../HOSTS.md)

## Supports

| Feature | pi hook | Notes |
| :-- | :-- | :-- |
| Stable prefix | `before_agent_start` | Shared stabilizer over prompt inputs (`appendSystemPrompt`, custom sections, context files). Volatile lines go to a trailing `tokenpilot_dynamic` section (target `developer`, default) or to the first user message (target `user`). Never forces a full system-prompt replacement, so pi keeps appending section deltas. |
| Reduction | `context` | Request-time reduction over the whole history, the same position as the Codex/Claude Code proxies. Tool-result text only; pi's session file keeps the originals. |
| Recovery | native tool `memory_fault_recover` | pi has no MCP. The tool has the same name, description and schema as the shared recovery MCP tool and calls the same resolver. The recovery protocol is added as a stable `tokenpilot_recovery` prompt section. |
| Eviction (opt-in, off by default) | `turn_end` → `context_edit` entries | Estimator-driven lifecycle eviction through the shared canonical-surface core in `@lightrsi/eviction`. Evicted originals are archived and recoverable. `turn_end` entries commit before pi's threshold auto-compaction check, so eviction runs before native compaction. |
| Modes | | `conservative`, `normal` (default). `aggressive` is not exposed. |

Current limitations:

- no in-host slash commands; use the shared `lightrsi pi ...` CLI
- the stabilizer is mostly a no-op on pi's default prompt, which has no volatile lines; it acts only on user and project prompt inputs that contain them
- the Context Cleaner is not integrated yet (see the design note)

## Install

```bash
pnpm install
npm --prefix components/adapters/pi run build
npm --prefix components/products/cli run build      # for the lightrsi CLI
npm --prefix components/adapters/pi run install:pi
```

Install writes:

- `~/.pi/agent/extensions/tokenpilot/index.js`: a marker-tagged loader that `require`s `components/adapters/pi/dist/extension.js`. pi auto-loads it. A pre-existing non-TokenPilot file at that path is moved to `index.js.bak-<timestamp>` first.
- `~/.pi/agent/tokenpilot.json`: runtime config in `normal` mode, created only if missing and never containing credentials.
- `~/.pi/agent/tokenpilot-install.json`: install manifest used by uninstall.
- `lightrsi` launcher in `~/.local/bin` (or `$LIGHTRSI_BIN_DIR`).

No pi-owned file (`settings.json`, `models.json`, `auth.json`) is modified. `PI_CODING_AGENT_DIR` and `TOKENPILOT_PI_CONFIG` are honoured.

Uninstall:

```bash
npm --prefix components/adapters/pi run uninstall:pi            # remove the loader, restore any backup
npm --prefix components/adapters/pi run uninstall:pi -- --purge # also remove the created config and state
```

## Verify

1. Start pi, or run `/reload` in a running session, so the extension loads.
2. `lightrsi pi doctor`
3. After a few turns: `lightrsi pi report`

A healthy doctor shows the loader and bundle present, a writable state dir, `declared features: stabilizer, reduction, eviction`, and the latest session once pi has started one.

## Commands

```bash
lightrsi pi status
lightrsi pi report
lightrsi pi doctor
lightrsi pi visual
lightrsi pi mode conservative
lightrsi pi mode normal
lightrsi pi stabilizer on|off
lightrsi pi stabilizer target developer|user
lightrsi pi reduction on|off
lightrsi pi reduction mode light|balanced|aggressive
lightrsi pi reduction pass <name> on|off
lightrsi pi eviction status|on|off
lightrsi pi eviction set minBlockChars <number>
```

Reduction passes: `readStateCompaction`, `toolPayloadTrim`, `htmlSlimming`, `execOutputTruncation`, `agentsStartupOptimization`.

## Configuration

`~/.pi/agent/tokenpilot.json` uses the same keys and defaults as the Claude Code adapter:

| Key | Default | Notes |
| :-- | :-- | :-- |
| `enabled` | `true` | Master switch; `false` makes every hook a no-op. |
| `modules.stabilizer` | `true` | |
| `hooks.dynamicContextTarget` | `developer` | `developer` or `user`. |
| `modules.reduction` | `true` | |
| `reduction.triggerMinChars` / `maxToolChars` | `2200` / `1200` | `conservative`: `4000` / `1800`. |
| `reduction.passes.*` | all `true` | |
| `reduction.stableArchiveHints` | `true` | Keeps a re-reduced tool result byte-identical across requests when only its timestamped `Archive:` path would change. Prevents prefix-cache invalidation. `false` gives the reference adapters' exact behaviour. |
| `modules.eviction` + `eviction.enabled` | `false` | Both must be on, plus the estimator settings below. |
| `eviction.minBlockChars` | `4000` | |
| `taskStateEstimator.baseUrl` / `model` / `apiKey` | unset | OpenAI-compatible endpoint for the task-state estimator. Keep the key out of checked-in files. |

Enabling eviction:

```bash
lightrsi pi eviction on
# then set taskStateEstimator.baseUrl / model / apiKey in ~/.pi/agent/tokenpilot.json
lightrsi pi doctor   # "eviction: active" once complete
```

## Runtime Files

```text
~/.pi/agent/tokenpilot-state/tokenpilot/
```

- `tokenpilot/adapter.log`: fail-open reasons and debug lines. Nothing is written to pi's terminal.
- `tokenpilot/tool-result-archives/<session>/`: originals of trimmed and evicted content (recovery)
- `session-state/latest.json`, `session-state/bindings/<session>.jsonl`
- `ux-effects/latest.json`, `ux-effects/sessions/<session>.json`
- the registry under the shared history layout (eviction task state, when enabled)

## Debugging

- `lightrsi pi doctor` lists every problem it finds.
- `tail ~/.pi/agent/tokenpilot-state/tokenpilot/tokenpilot/adapter.log`: every hook that failed open logs `<hook> failed open <error>`. pi then continues with its own, unmodified data.
- Set `"logLevel": "debug"` in `tokenpilot.json` for eviction readiness details.
- To confirm the extension loaded, run pi with `--verbose` and look for the `tokenpilot` extension.

## Package Scripts

```bash
npm --prefix components/adapters/pi run build
npm --prefix components/adapters/pi run typecheck
npm --prefix components/adapters/pi test
npm --prefix components/adapters/pi run install:pi
npm --prefix components/adapters/pi run uninstall:pi
npm --prefix components/adapters/pi run doctor:pi
```
