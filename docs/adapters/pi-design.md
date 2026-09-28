# TokenPilot adapter design: pi

Status: implemented in `components/adapters/pi/` (this note is kept in sync with what was built).

## Pinned versions

| Item | Value |
| :-- | :-- |
| LightRSI base commit | `3b7f28d76c98de85999cf94ae99d39ad144fa327` |
| pi package | `@earendil-works/pi-coding-agent@0.87.1` (npm `latest` on 2026-09-28) |
| pi runtime deps checked | `@earendil-works/pi-ai@0.87.1`, `@earendil-works/pi-agent-core@0.87.1` |
| Sources checked | the published package's `dist/core/extensions/types.d.ts`, `dist/core/session-manager.d.ts`, `dist/core/system-prompt.{d.ts,js}`, `dist/core/messages.d.ts`, `docs/extensions.md`, `docs/compaction.md`, `docs/session-format.md` |

Every "verified" statement below cites one of those files. pi ships its type
declarations and docs inside the npm tarball, so the pinned version's contract
can be read without cloning the monorepo.

## Design First (playbook questions)

| Question | Answer for pi 0.87.1 | Evidence |
| :-- | :-- | :-- |
| Can the host rewrite requests before model execution? | Yes, in process. `context` returns replacement messages for one LLM call; `context_with_system` owns the full transcript; `before_provider_request` can replace the raw provider payload; `before_agent_start` can mutate structured prompt sections. | `types.d.ts` `ContextEvent`, `ContextWithSystemEvent`, `BeforeProviderRequestEvent`, `BeforeAgentStartEvent` |
| Can it rewrite responses after model execution? | Yes. `message_end` can replace a finalized message (same role). `tool_result` handlers can replace tool results before they enter the session. | `MessageEndEventResult`, `ToolResultEventResult` |
| Streaming chunks, final responses, or both? | Both: `message_update` (token stream, notification only) and `message_end` (final, replaceable). | `MessageUpdateEvent`, `MessageEndEvent` |
| Transcript history exposed directly, or reconstructed? | Directly. `context` receives the model-bound `AgentMessage[]`; `ctx.sessionManager.getBranch()` returns the active branch's session entries. | `ContextEvent`, `ReadonlySessionManager` |
| File-, hook-, plugin- or API-based? | Plugin (in-process TypeScript extension loaded through `jiti`) plus native tool registration. No proxy is needed. | `docs/extensions.md` |

## Host facts verified against 0.87.1

| Brief claim | Result | Evidence |
| :-- | :-- | :-- |
| `before_agent_start` exposes structured `systemPromptOptions`; changing sections lets pi append a delta instead of replacing the prompt | Confirmed. `systemPromptOptions: NormalizedBuildSystemPromptOptions` is mutable; returning `systemPrompt` forces a full replacement. Sections are rendered by `buildSystemPromptSections` and diffed by `diffSystemPromptSections`. | `types.d.ts` `BeforeAgentStartEvent` / `BeforeAgentStartEventResult`; `system-prompt.js` |
| `context` / `context_with_system` are request-local transforms | Confirmed. `context` excludes system messages and pi restores prompt/tool state afterwards. | `types.d.ts` doc comments on `ContextEvent` / `ContextWithSystemEvent` |
| `tool_result` handlers compose and can replace a result before it enters the session | Confirmed (`content`, `details`, `isError`, `usage`). | `ToolResultEventResult`, `docs/extensions.md` "Events and concurrency" |
| `tool_call` can mutate input or block | Confirmed. A `tool_call` handler failure blocks the tool (fail-safe, not fail-open). | `ToolCallEventResult`, `docs/extensions.md` "Errors and cleanup" |
| `turn_end` / `agent_before_settle` can return `context_edit` or `compaction` entries | Confirmed (`SessionBoundaryDraft = custom | custom_message | context_edit | compaction`). `context_edit.replacement` is `{content}` or `null` (omit from context). | `BoundaryResult`, `ContextEditEntryDraft`, `session-manager.d.ts` `ContextEditEntry` |
| `session_before_compact` can cancel or supply a custom summary | Confirmed (`cancel`, `compaction`). Event carries `reason: manual|threshold|overflow`. | `SessionBeforeCompactEvent`, `SessionBeforeCompactResult` |
| `pi.registerTool()`; does pi support MCP natively? | `registerTool` confirmed. **No native MCP**: neither the docs nor the extension types mention MCP. | `docs/*.md` (no MCP references), `types.d.ts` |
| `pi.appendEntry()` and `getBranch()`; sessions branch | Confirmed. Docs say to rebuild branch-sensitive state from `getBranch()` at `session_start`. | `docs/extensions.md` "State" |
| Do not start long-lived resources in the factory | Confirmed. | `docs/extensions.md` "Respect the runtime lifecycle" |
| Handler errors | pi "reports handler errors and continues where possible" — except `tool_call`, which blocks. The adapter still catches everything itself so a TokenPilot failure is never surfaced as a host error. | `docs/extensions.md` "Errors and cleanup" |

Additional facts that shaped the design:

- The default pi system prompt has no volatile lines (no date/time). `cwd` is its own
  `<cwd>` section. pi already keeps the provider prefix stable by recording the
  structured prompt once and appending section deltas.
  (`system-prompt.js` `buildSystemPromptSections`.)
- Session identity: `ctx.sessionManager.getSessionId()`, `getSessionFile()`, `getCwd()`.
  Turn identity: `turn_start.turnIndex`. (`session-manager.d.ts`, `TurnStartEvent`.)
- Agent directory: `~/.pi/agent` (override `PI_CODING_AGENT_DIR`); user extensions
  load from `<agent-dir>/extensions/` as a file or a directory with `index.{ts,js}`.
  (`docs/configuration.md`, `docs/extensions.md`.)

## Surface table

| Surface | pi 0.87.1 | Closest existing adapter precedent |
| :-- | :-- | :-- |
| Install / uninstall flow | `install:pi` writes a marker-tagged loader `~/.pi/agent/extensions/tokenpilot/index.js` that imports the built `dist/extension.js`, plus runtime config `~/.pi/agent/tokenpilot.json` (normal mode). No pi-owned config file is modified. `uninstall:pi` removes the loader only if it carries the TokenPilot marker; an existing non-TokenPilot file at that path is backed up (`.bak-<ts>`) before install and restored on uninstall. | Claude Code / Codex `install.ts` (runtime config file next to host config; reversible) |
| Session id, turn id, workspace root | `ctx.sessionManager.getSessionId()`; `turn_start.turnIndex` (counter per session); `ctx.cwd`. | Claude Code hook `SessionStart` + session snapshot |
| Transcript bridge (host ↔ canonical) | `AgentMessage[]` ↔ `HostRequestEnvelope.messages` (`RuntimeMessage`). `user`→`user` (text/image blocks); `assistant` text→`text`, `toolCall`→`tool_call`, `thinking`→ preserved verbatim in message metadata (the kernel has no reasoning block); `toolResult`→`tool` role with one `tool_result` block; `custom`, `bashExecution`, `branchSummary`, `compactionSummary` → pass-through messages (never rewritten). Encode applies canonical tool-result text back onto the original host object, so an unchanged envelope round-trips byte-for-byte. | Claude Code `messages-codec.ts` (host payload ↔ envelope) |
| Stable-prefix path | `before_agent_start`: run the shared stabilizer (`rewriteTextForStablePrefix`) over each mutable prompt input (`appendSystemPrompt`, custom `sections`, context-file contents). Target `developer` (default): volatile lines move to a trailing `tokenpilot_dynamic` section so pi emits a section delta instead of a full prompt replacement. Target `user`: volatile lines are returned as the handler's `message` (custom message) instead. `systemPrompt`/`forceSystemPrompt` are never used. Stable-prefix fingerprint and visual snapshot come from the shared `buildStabilityVisualSnapshotFromEnvelopes`. | OpenClaw `root-prompt-stabilizer.ts` (shared `rewriteTextForStablePrefix`) |
| Reduction path | `context` (request-local, fires before every LLM call): decode → canonical envelope → shared before-call pipeline (`prepareObservedBeforeCall` → `@lightrsi/reduction` analyzers + `runReductionBeforeCall`) → encode the reduced tool-result text back. Same position in the request lifecycle as the Codex/Claude Code proxies and OpenClaw's request-time reduction. | Claude Code `reduction.ts` + `prepareObservedBeforeCall` |
| Eviction path (opt-in) | **Not declared.** The host has the right primitive (persistent `context_edit` entries from `turn_end` / `agent_before_settle`, ordered before `session_before_compact`), but the only lifecycle/safety/tool-closure implementation that targets a durable canonical surface lives inside the DeepSeek Harness adapter, not in a shared package. See gaps. | DeepSeek Harness `eviction-engine.ts` (would be the precedent) |
| Recovery path | pi has no MCP, so `pi.registerTool({ name: "memory_fault_recover" })` exposes the same tool name, description and JSON schema as the shared MCP server and calls the shared `resolveMemoryFaultRecover` from `@lightrsi/mcp` (the function behind the MCP server's `tools/call`). | Codex / Claude Code register the shared MCP server; OpenClaw registers a native tool |
| Runtime state root, namespace, archive path | Config `~/.pi/agent/tokenpilot.json` (override `TOKENPILOT_PI_CONFIG`). State `~/.pi/agent/tokenpilot-state/tokenpilot/`, namespace `tokenpilot`, archives `<stateDir>/tokenpilot/tool-result-archives/<session>/` via `configureStatePathResolver`. | Claude Code (`~/.claude/tokenpilot-state/tokenpilot/`) |
| Status, report, doctor, visual | Shared CLI registration: `lightrsi pi status|report|doctor|visual|mode|stabilizer|reduction`. Report/visual read `ux-effects` written by the shared observability path. `doctor` checks config, loader file, built bundle, state dir, recovery tool wiring, and last activity. | Claude Code `products/cli/src/hosts/claude-code.ts` |
| Declared feature subset (`host-binding.ts`) | `stabilizer`, `reduction`. | Claude Code originally declared the same pair |
| Supported modes | `conservative`, `normal` (default). `aggressive` refused (requires eviction). | Codex, Claude Code |

## Behavioural decisions

### Reduction runs at request time, not at `tool_result`

The brief suggests `tool_result` for reduction. All three reference adapters run
reduction at request time over the whole outgoing history (Codex/Claude Code proxies,
OpenClaw's default path; OpenClaw's persistent `tool_result_persist` is opt-in and off
by default). Request-time reduction is also what the `read_state_compaction` pass needs:
it compacts an earlier read once a later read supersedes it, which a single
`tool_result` event cannot see. Using `tool_result` would therefore change what
reduction does, which the fidelity rule forbids. `tool_result` is not hooked.

Consequence: pi's session file keeps the full original tool output; only the model
request sees reduced text. Native pi compaction therefore summarises the original
outputs (correct, but it does not benefit from reduction).

### Archive-path stabilisation (documented divergence)

The shared recovery hint embeds `Archive: <stateDir>/…/<Date.now()>-<segmentId>.json`
(`artifact-store` `buildArchiveLocation` + `buildRecoveryHint`). When reduction is
re-run on every request, as all request-time adapters do, the same tool output gets a
new archive path on every call. The rewritten history then differs from the previous
request at the first reduced tool result, which invalidates any prefix cache from that
point. This is most visible on llama-server, whose cache is a plain longest-common-prefix
match.

The adapter keeps a per-session memo keyed by `(segment id, sha256(original text))`.
When the shared pipeline's new output for a segment differs from the memoised output
**only** in the `Archive:` line, the memoised text is reused verbatim. Any other change,
for example `read_state_compaction` superseding the earlier trim, passes through
unchanged. The first archive still exists and carries the same `dataKey`, so recovery is
unaffected. The memo does not change any pass's decision. It is on by default and
controlled by `reduction.stableArchiveHints`. Setting it to `false` gives the
reference adapters' exact behaviour.

### Segment identity

Claude Code uses message-index segment ids (`message-<i>-block-<j>`). Index ids shift
whenever pi compacts or a branch changes, which would defeat the memo above. The pi
adapter uses `tool-<toolCallId>` for tool-result segments (tool-call ids are stable in
pi sessions) and falls back to index ids only when an id is missing. Segment ids are
opaque to the shared passes. They are used only for archive file names and bindings.

### Fail-open

Every hook body runs inside a guard. On any exception it returns `undefined` (pi
proceeds unmodified) and appends a line to `<stateDir>/tokenpilot/adapter.log`. Nothing
is written to stdout or stderr, because pi's TUI owns the terminal. Malformed messages
(unknown roles, non-array content) are passed through untouched by the codec. The
recovery tool reports "not found" as an ordinary text result, not a thrown error, which
matches the MCP server's `isError` result rather than a transport failure.

### Branching

The adapter keeps no branch-sensitive state in the session. The reduction memo is keyed
by content hash, so it is valid on every branch. Per-session caches are reset on
`session_start` (reasons `startup|reload|new|resume|fork`) and released on
`session_shutdown`. Nothing is started in the extension factory.

## Gaps against the reference (OpenClaw) and how each is handled

| Gap | Handling |
| :-- | :-- |
| Eviction (estimator-driven lifecycle eviction) not implemented | Declared unsupported in `host-binding.ts`. The `eviction` CLI command and `mode aggressive` are refused. Config keys `modules.eviction`, `eviction.enabled` and `taskStateEstimator.{baseUrl,model,apiKey}` are accepted with the same names and defaults as Claude Code, but the readiness gate reports `unsupported_on_host` even when complete. Path to support: move DSH's eviction cycle, safety policy and tool-closure checks (`deepseek-harness/src/eviction-*.ts`, `safety-policy.ts`, `tool-closure.ts`) into `@lightrsi/eviction`, then emit `context_edit` entries from `agent_before_settle` and run before `session_before_compact`. That is a shared-package change, left as an open question. |
| No MCP in pi | Recovery is a native tool backed by the shared `resolveMemoryFaultRecover`. The tool name and schema are identical to the MCP tool. |
| Reduction is request-local, so pi's persisted session keeps full outputs | Same as the Codex/Claude Code proxies. Documented above. |
| No in-host slash commands | Same as Codex/Claude Code: the shared `lightrsi pi ...` CLI is the control surface. |
| Stabilizer is mostly a no-op on the default pi prompt | pi already emits section deltas, and its default prompt contains no volatile lines. The stabilizer acts only when user or project prompt inputs carry volatile lines (dates, request ids, ...). This is reported in `status` and the visual, not hidden. |
| `prompt_cache_key` routing (Codex/Claude Code) | Not applicable to local OpenAI-compatible servers, which cache by prefix. Not emitted. |
| Context Cleaner | Out of scope. See below. |

## Context Cleaner (future)

pi can host the Cleaner natively: `pi.registerCommand("tokenpilot-clean")` for the
analyse/select flow, a durable schedule via `pi.appendEntry("tokenpilot-cleaner", …)`
(branch-aware), and the one allowed canonical rewrite as `context_edit` entries returned
from the next `agent_before_settle`. The DSH adapter's `cleaner-pre-step.ts` is the
closest precedent. It depends on the same shared eviction primitives listed above.
