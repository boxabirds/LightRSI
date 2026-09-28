# TokenPilot adapter design: OpenCode

Status: implemented in `components/adapters/opencode/`. This note was written before implementation and updated afterwards to match what was built.

## Pinned versions

| Item | Value |
| :-- | :-- |
| LightRSI base commit | `3b7f28d76c98de85999cf94ae99d39ad144fa327` |
| OpenCode | `opencode-ai@1.18.33` (npm `latest` on 2026-09-28); source tag `v1.18.33` of `anomalyco/opencode` (commit `51ef4be`) |
| Plugin API package | `@opencode-ai/plugin@1.18.33`, types from `@opencode-ai/sdk@1.18.33` |

Every "verified" statement cites a path in that source tag (`packages/opencode/src/...`,
`packages/core/src/...`) or in the published plugin package (`dist/index.d.ts`).

## Plugin API choice: v1 `Hooks`

`@opencode-ai/plugin@1.18.33` ships both the v1 `Hooks` interface (`dist/index.d.ts`) and
a v2 API (`dist/v2/promise`, `Plugin.define`). The v2 `PluginContext` in this version
exposes only the `agent`, `aisdk`, `catalog`, `command`, `integration`, `plugin`,
`reference` and `skill` domains (`dist/v2/promise/context.d.ts`). It has **no**
message, tool or session hook, and there is no `ctx.session.hook("context")` in 1.18.33.
Every surface TokenPilot needs exists only in v1, so the adapter is a v1 plugin:
`export default { id: "tokenpilot", server }` (read by `readV1Plugin`,
`plugin/shared.ts:272`).

## Design First (playbook questions)

| Question | Answer for OpenCode 1.18.33 | Evidence |
| :-- | :-- | :-- |
| Can the host rewrite requests before model execution? | Yes. `experimental.chat.messages.transform` mutates the message list before each model step; `experimental.chat.system.transform` mutates the system prompt; `chat.params` mutates sampling options. | `session/prompt.ts:1255`, `session/llm/request.ts:67-72`, `:114-131` |
| Can it rewrite responses after model execution? | Partly. `tool.execute.after` can mutate a tool's `output` before it is recorded; `experimental.text.complete` can rewrite a finished text part. There is no hook for a whole assistant message. | `session/tools.ts:122` etc., plugin `dist/index.d.ts` |
| Streaming chunks, final responses, or both? | Plugins see neither raw stream nor raw response. They observe persisted parts through the `event` hook (`message.part.updated` with `delta`). | `dist/index.d.ts` `event`, SDK `EventMessagePartUpdated` |
| Transcript history exposed directly, or reconstructed? | Directly, per step: `messages.transform` receives `{ info: Message; parts: Part[] }[]`, loaded fresh from storage on every loop iteration (`MessageV2.filterCompactedEffect`, `session/prompt.ts:1092`). | `session/prompt.ts` |
| File-, hook-, plugin- or API-based? | Plugin (in-process Bun module) plus native MCP config. | `config/plugin.ts`, core `v1/config/mcp.ts` |

## Host facts verified against 1.18.33

| Brief claim | Result | Evidence |
| :-- | :-- | :-- |
| `experimental.chat.system.transform` mutates the system prompt array | Confirmed. Fired per LLM request with `{ sessionID, model }` and `{ system }`. At trigger time `system` has one joined string. If a plugin appends entries, OpenCode re-joins them to `[header, rest]`. | `session/llm/request.ts:57-78`; also `agent/agent.ts:381` for agent generation |
| `tool.definition` mutates tool descriptions/schemas | Confirmed. | `tool/registry.ts:318` |
| `chat.message`, `chat.params` | Confirmed. `chat.params` output: `temperature, topP, topK, maxOutputTokens, options`. | `session/prompt.ts:1000`, `session/llm/request.ts:114` |
| `experimental.chat.messages.transform`: every model call, or only around compaction? | **Every model step.** Triggered in the main loop right before `MessageV2.toModelMessagesEffect` (`session/prompt.ts:1255`), and also for the compaction summariser's request (`session/compaction.ts:379`). Input is `{}` (no sessionID); session id comes from `messages[*].info.sessionID`. Only in-place mutation of the passed array is observed: the caller keeps using its own `msgs` binding. | `session/prompt.ts`, `session/compaction.ts` |
| `tool.execute.after` "declared but never invoked" (anomalyco/opencode #25918) | **Not reproduced in 1.18.33.** It is triggered after every built-in tool (`session/tools.ts:122`), MCP tool (`:209`, `:292`, `:374`, `:421`), task/subtask tool (`session/prompt.ts:390`) and code-mode tool (`tool/code-mode.ts:181`), with a mutable `output`. It is not used for reduction (see below). | `session/tools.ts` |
| `experimental.session.compacting` | Confirmed: `context: string[]`, optional `prompt` override. | `session/compaction.ts:374` |
| v1 vs v2 API | See "Plugin API choice" above. | |
| OpenCode prunes old tool outputs natively (last ~40k tokens protected) | Mechanism confirmed: `PRUNE_PROTECT = 40_000`, `PRUNE_MINIMUM = 20_000`, skips the last 2 user turns and the `skill` tool; pruned outputs render as `[Old tool result content cleared]`. It is **off by default in 1.18.33**: `compaction.prune` "(default: false)", and `prune()` returns early unless it is set. `OPENCODE_DISABLE_PRUNE` forces it off. | `session/compaction.ts:28-31,273-317`, core `v1/config/config.ts:154`, `config/config.ts:596`, `session/message-v2.ts:297` |
| Native MCP | Confirmed. `mcp.<name> = { type: "local", command: string[], environment }`. The model sees tool `<sanitized server>_<sanitized tool>`. | core `v1/config/mcp.ts`, `mcp/catalog.ts:119` |
| Hook errors | `Plugin.trigger` runs each hook through `Effect.promise` with **no catch** (`plugin/index.ts:284-297`), so a throwing hook fails the whole request. The adapter must catch everything itself to fail open. | `plugin/index.ts` |

Other facts used:

- Global config dir: `$XDG_CONFIG_HOME/opencode` (default `~/.config/opencode`). Files merged in order:
  `config.json`, `opencode.json`, `opencode.jsonc` (`config/config.ts:272-274`). Plugins
  auto-load from `{plugin,plugins}/*.{ts,js}` in that dir (`config/plugin.ts:21`).
- Native tool-output truncation happens before the model and before our hooks see the
  output: default 2000 lines / 50 KiB, configurable via `tool_output.max_lines|max_bytes`
  (`tool/truncate*.ts`). TokenPilot reduction therefore operates on already-truncated
  outputs.
- OpenCode sends the system prompt as its own message(s) ahead of history
  (`session/llm/request.ts:98-111`). Its environment block contains
  `Today's date: …`, which the shared stabilizer classifies as volatile.

## Surface table

| Surface | OpenCode 1.18.33 | Closest existing adapter precedent |
| :-- | :-- | :-- |
| Install / uninstall flow | `install:opencode` (1) writes a marker-tagged loader `~/.config/opencode/plugins/tokenpilot.js` that re-exports the built `dist/plugin.js`; (2) registers the shared recovery MCP server under `mcp.tokenpilot_memory_fault_recover` in `~/.config/opencode/opencode.json` after writing a timestamped backup; (3) writes runtime config `~/.config/opencode/tokenpilot.json` (normal mode). If only `opencode.jsonc` exists, it is **not** rewritten (comments would be lost): the installer prints the MCP snippet and `doctor` reports it missing. `uninstall:opencode` removes the loader (marker-checked) and exactly the `mcp` key it added, and leaves every other user edit alone. | Codex / Claude Code `install.ts` (MCP registration + backups) |
| Session id, turn id, workspace root | `sessionID` from hook input (`system.transform`, tool hooks) or `messages[*].info.sessionID` (`messages.transform`); turn id = id of the last `user` message; workspace = `PluginInput.worktree` (fallback `directory`). | Claude Code hook session binding |
| Transcript bridge (host ↔ canonical) | `{info, parts}[]` ↔ `RuntimeMessage[]`. User `text` → `text`; user `file` with `image/*` mime → `image`, other files → preserved. Assistant `text` → `text`; `reasoning` → preserved verbatim (no kernel block); completed/error `tool` part → `tool_call` on the assistant message plus a following `tool` role message with a `tool_result` (`output`, `error`, or the native `[Old tool result content cleared]` placeholder when `time.compacted` is set). `step-*`, `snapshot`, `patch`, `agent`, `retry`, `compaction`, `subtask`, pending/running tools → preserved, never rewritten. Encode writes changed tool-result text into a **cloned** part and swaps the clone into the array, so storage objects are never mutated. | Claude Code `messages-codec.ts` |
| Stable-prefix path | `experimental.chat.system.transform`: run the shared `applyStablePrefixToInstructions` over `system[0]` with target `developer`, so volatile lines (`Today's date: …`) move to the tail of the system prompt. Then the shared recovery protocol is appended, idempotently, from the shared injector. **Target `user` is not supported**: in 1.18.33 `messages.transform` runs before `system.transform` in the same step (`session/prompt.ts:1255` vs `session/llm/request.ts:67`), so the volatile lines are not known when the first user message could still be changed. The config value is accepted, runs as `developer`, and is logged once and reported by `doctor`. The visual snapshot comes from the shared `buildStabilityVisualSnapshotFromEnvelopes`. | OpenClaw `root-prompt-stabilizer.ts` / shared stabilizer |
| Reduction path | `experimental.chat.messages.transform` (every model step): decode → canonical envelope → shared before-call pipeline (`prepareObservedBeforeCall` → `@lightrsi/reduction`) → encode back into cloned parts. Same request-time position as the Codex/Claude Code proxies and OpenClaw. | Claude Code `reduction.ts` + `prepareObservedBeforeCall` |
| Eviction path (opt-in) | `experimental.chat.messages.transform`. Plugins have no persistent part-edit hook, so eviction is a request-local overlay, as in Claude Code. Canonical messages → surface entries (`part:<id>` / `msg:<id>`) → shared `runCanonicalEvictionCycle` (`@lightrsi/eviction` canonical-surface core, lifted from DSH). Accepted replacements (stub plus recovery hint, originals archived) are stored in `<stateDir>/tokenpilot/eviction-overlay/<session>.json` and re-applied identically on every later request, so decisions are durable and the prefix stays stable. It runs before reduction, like the Claude Code gateway. It is isolated, so an estimator failure never disables reduction. Off by default. | Claude Code overlay approach; DSH cycle |
| Recovery path | The shared recovery MCP server (`@lightrsi/mcp` `dist/server.js`, `TOKENPILOT_STATE_DIR` env) registered as a native OpenCode MCP server, as Codex and Claude Code do. The model sees it as `tokenpilot_memory_fault_recover_memory_fault_recover` (OpenCode's `server_tool` naming), the same way Claude Code shows `mcp__tokenpilot_memory_fault_recover__memory_fault_recover`. | Codex, Claude Code |
| Runtime state root, namespace, archive path | Config `~/.config/opencode/tokenpilot.json` (override `TOKENPILOT_OPENCODE_CONFIG`). State `~/.config/opencode/tokenpilot-state/tokenpilot/`, namespace `tokenpilot`, archives `<stateDir>/tokenpilot/tool-result-archives/<session>/`. | Claude Code |
| Status, report, doctor, visual | Shared CLI registration: `lightrsi opencode status|report|doctor|visual|mode|stabilizer|reduction`. `doctor` checks config, loader, built bundle, MCP registration (command, args, `TOKENPILOT_STATE_DIR`), MCP probe, `compaction.prune` setting, and last activity. | Claude Code |
| Declared feature subset (`host-binding.ts`) | `stabilizer`, `reduction`, `eviction` (eviction opt-in). | Codex, Claude Code |
| Supported modes | `conservative`, `normal` (default). `aggressive` refused. | Codex, Claude Code |

## Behavioural decisions

### Reduction runs at request time, not in `tool.execute.after`

`tool.execute.after` does fire in 1.18.33, but reducing there would persist a
single-segment reduction into the session. All reference adapters reduce at request time
over the full history, which `read_state_compaction` requires. `messages.transform` is
the request-time position, so it is used. `tool.execute.after` is not hooked.

### Archive-path stabilisation (documented divergence)

This is the same memo as the pi adapter, keyed by `(tool-<callID>, sha256(original))`.
It reuses the first reduction text when a re-run differs only in the timestamped
`Archive:` line. Without it, every request would rewrite earlier tool results and break
prefix caching from the first reduced output onward. Controlled by
`reduction.stableArchiveHints` (default `true`). `false` gives the reference adapters'
exact behaviour.

### Native pruning interaction

TokenPilot does not change `compaction.prune`. `doctor` and `status` report its effective
value.

- Off (the 1.18.33 default): reduction is the only thing shrinking old tool outputs,
  apart from native truncation at 50 KiB / 2000 lines.
- On: once more than 40k tokens of newer tool output exist, OpenCode persistently
  replaces older outputs with `[Old tool result content cleared]` (the recovery MCP
  cannot restore those, but the adapter never archived them either, because they are
  below the reduction thresholds). Newer outputs are still reduced request-locally by
  TokenPilot. The two do not conflict: a pruned part is below `triggerMinChars` and the
  passes skip it. Pruning does rewrite earlier history, so it moves the cached prefix
  boundary. That is OpenCode's own trade-off, and it is documented in the README as a
  setting the user owns.

### Fail-open

Every hook body is wrapped. On exception, the hook leaves `output` untouched (all
mutations are staged on clones and committed only after the whole pipeline succeeds) and
logs to `<stateDir>/tokenpilot/adapter.log`. This matters more here than on pi because
OpenCode does **not** catch plugin exceptions.

## Gaps against the reference (OpenClaw) and how each is handled

| Gap | Handling |
| :-- | :-- |
| Eviction needed shared primitives | Solved by the same shared-package change as pi: the DSH canonical-surface core moved into `@lightrsi/eviction`. OpenCode applies it through a durable overlay. `eviction on/off/set minBlockChars` are exposed as on Claude Code. |
| `dynamicContextTarget=user` | Not supported in 1.18.33 (hook order, above). Runs as `developer`; `doctor` warns. |
| `mode aggressive` | Not exposed, as on Claude Code. Open question for a human. |
| Recovery tool name is prefixed by OpenCode | Same situation as Claude Code (`mcp__…`). The recovery hint names `memory_fault_recover`; the only matching tool is the prefixed one. Verified in the live smoke run (see PR). |
| Reduction is request-local; stored parts keep full output | Same as the Codex/Claude Code proxies. |
| `opencode.jsonc`-only installs | MCP registration is printed, not written, so comments are never destroyed. `doctor` flags it. |
| No in-host slash commands | Shared `lightrsi opencode ...` CLI. |
| `prompt_cache_key` routing | Not emitted. OpenCode already sets its own `promptCacheKey` for providers that support it, and local servers cache by prefix. |
| Context Cleaner | Out of scope. See below. |

## Context Cleaner (future)

A v1 plugin can add a `/tokenpilot-clean` command through `command.execute.before` or a
custom `tool`, persist the schedule under the adapter state dir, and apply the selected
cleanup request-locally in the next `messages.transform`. That is the same
"schedule now, apply on next request" shape as DSH's `cleaner-pre-step.ts`, with Claude
Code's request-overlay semantics, because OpenCode has no persistent part-edit hook for
plugins.
