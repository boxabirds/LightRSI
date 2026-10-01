# TokenPilot OpenCode Adapter

This package integrates TokenPilot with [OpenCode](https://opencode.ai) (verified on **1.18.33**) as an in-process v1 plugin, plus the shared recovery MCP server registered in OpenCode's own config.

This adapter explicitly binds the TokenPilot `stabilizer`, `reduction`, and `eviction` features. Its product registration provides OpenCode state discovery to the shared CLI and Visual surface.

Design, host facts and gaps: [`docs/adapters/opencode-design.md`](../../../docs/adapters/opencode-design.md).

## Supports

| Feature | OpenCode hook | Notes |
| :-- | :-- | :-- |
| Stable prefix | `experimental.chat.system.transform` | Shared stabilizer: volatile lines (e.g. `Today's date: …`) move to the tail of the system prompt. |
| Reduction | `experimental.chat.messages.transform` | Runs before every model step (verified in 1.18.33). Request-time, over the whole history. Stored message parts keep the originals. |
| Recovery | shared recovery MCP server | Registered as `mcp.tokenpilot_memory_fault_recover`. OpenCode shows the tool as `tokenpilot_memory_fault_recover_memory_fault_recover`. The recovery protocol is appended to the system prompt. |
| Eviction (opt-in, off by default) | `experimental.chat.messages.transform` + durable overlay | OpenCode has no persistent part-edit hook for plugins, so evictions are stored per session and re-applied identically on every request (Claude Code's overlay approach). Estimator failures never disable reduction. |
| Modes | | `conservative`, `normal` (default). `aggressive` is not exposed. |

Current limitations:

- `hooks.dynamicContextTarget=user` runs as `developer`: in 1.18.33, `messages.transform` runs before `system.transform`, so volatile lines cannot be moved into the same request's first user message. `doctor` reports this.
- the v2 plugin API is not used: in 1.18.33 it has no message, tool or session hooks
- no in-host slash commands; use the shared `lightrsi opencode ...` CLI
- the Context Cleaner is not integrated yet (see the design note)

### Native tool-output pruning

OpenCode can prune old tool outputs itself (`compaction.prune`: keeps roughly the last 40k tokens of tool output and clears older ones to `[Old tool result content cleared]`). It is **off by default in 1.18.33**. TokenPilot never changes this setting. `lightrsi opencode doctor` reports it as `native tool-output pruning: on|off`.

- Off: TokenPilot reduction is the only thing trimming old outputs, apart from OpenCode's own truncation at 2000 lines / 50 KiB (`tool_output.max_lines|max_bytes`).
- On: pruned outputs are skipped by TokenPilot, since they are below the reduction thresholds and are never evicted. Pruning rewrites earlier history persistently, which moves the cached-prefix boundary; that trade-off is OpenCode's and yours to choose.

## Install

```bash
pnpm install
pnpm --filter @lightrsi/mcp build                   # recovery MCP server
npm --prefix components/adapters/opencode run build
npm --prefix components/products/cli run build      # for the lightrsi CLI
npm --prefix components/adapters/opencode run install:opencode
```

Install writes, in OpenCode's global config dir (`$XDG_CONFIG_HOME/opencode`, default `~/.config/opencode`):

- `plugins/tokenpilot.js`: a marker-tagged ESM loader re-exporting `components/adapters/opencode/dist/plugin.mjs`. OpenCode auto-loads `plugins/*.js`. A foreign file at that path is moved to `tokenpilot.js.bak-<timestamp>` first.
- `opencode.json`: adds exactly one key, `mcp.tokenpilot_memory_fault_recover`, after copying the file to `opencode.json.tokenpilot-backup-<timestamp>`. The file is created if it does not exist.
- `tokenpilot.json`: runtime config in `normal` mode, created only if missing and never containing credentials.
- `tokenpilot-install.json`: install manifest used by uninstall.

If you only have an `opencode.jsonc`, or your `opencode.json` is not plain JSON, install **does not rewrite it**. It prints the MCP snippet for you to paste, so your comments are never lost. `doctor` flags the missing entry.

Uninstall removes the loader and exactly that MCP key (and an `opencode.json` it created, once nothing else is in it):

```bash
npm --prefix components/adapters/opencode run uninstall:opencode
npm --prefix components/adapters/opencode run uninstall:opencode -- --purge   # also created config + state
```

`TOKENPILOT_OPENCODE_CONFIG_DIR` and `TOKENPILOT_OPENCODE_CONFIG` override the locations.

## Verify

1. Restart OpenCode so the plugin and the MCP server load.
2. `lightrsi opencode doctor`: the loader, bundle and MCP entry should be present, and the MCP probe should be `ok`.
3. After a few turns: `lightrsi opencode report`

## Commands

```bash
lightrsi opencode status
lightrsi opencode report
lightrsi opencode doctor
lightrsi opencode visual
lightrsi opencode mode conservative|normal
lightrsi opencode stabilizer on|off
lightrsi opencode reduction on|off
lightrsi opencode reduction pass <name> on|off
lightrsi opencode eviction status|on|off
lightrsi opencode eviction set minBlockChars <number>
```

## Configuration

`~/.config/opencode/tokenpilot.json` uses the same keys and defaults as the Claude Code adapter. Config edits, including `lightrsi opencode mode ...`, apply on the next request without restarting OpenCode.

| Key | Default | Notes |
| :-- | :-- | :-- |
| `enabled` | `true` | Master switch; `false` makes every hook a no-op. |
| `modules.stabilizer` | `true` | |
| `hooks.dynamicContextTarget` | `developer` | `user` is not available on OpenCode 1.18.33 (see Supports above); it runs as `developer`. |
| `modules.reduction` | `true` | |
| `reduction.triggerMinChars` / `maxToolChars` | `2200` / `1200` | `conservative`: `4000` / `1800`. |
| `reduction.passes.*` | all `true` | |
| `modules.eviction` + `eviction.enabled` | `false` | Both must be on, plus the estimator settings below. |
| `eviction.minBlockChars` | `4000` | |
| `taskStateEstimator.baseUrl` / `model` / `apiKey` | unset | OpenAI-compatible endpoint for the task-state estimator. Keep the key out of checked-in files. |

Enabling eviction:

```bash
lightrsi opencode eviction on
# then set taskStateEstimator.baseUrl / model / apiKey in ~/.config/opencode/tokenpilot.json
lightrsi opencode doctor   # "eviction: active" once complete
```

## Runtime Files

```text
~/.config/opencode/tokenpilot-state/tokenpilot/
```

- `tokenpilot/adapter.log`: fail-open reasons. OpenCode does not catch plugin errors, so every hook catches its own and continues unmodified.
- `tokenpilot/tool-result-archives/<session>/`: recovery archives
- `tokenpilot/reduction-memo/<session>.json`: which read disclosed which file, so a restarted OpenCode (`opencode run --continue`) still honours deliberate re-reads
- `tokenpilot/eviction-overlay/<session>.json`: durable eviction decisions (when eviction is on)
- `session-state/…`, `ux-effects/…`: report and visual data

## Debugging

- `lightrsi opencode doctor`
- `tail ~/.config/opencode/tokenpilot-state/tokenpilot/tokenpilot/adapter.log`
- `opencode run --print-logs --log-level DEBUG "…"` shows plugin and MCP loading.
- `opencode run --pure "…"` runs without external plugins, to compare with TokenPilot off.

## Package Scripts

```bash
npm --prefix components/adapters/opencode run build
npm --prefix components/adapters/opencode run typecheck
npm --prefix components/adapters/opencode test
npm --prefix components/adapters/opencode run install:opencode
npm --prefix components/adapters/opencode run uninstall:opencode
npm --prefix components/adapters/opencode run doctor:opencode
```
