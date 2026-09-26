# TokenPilot OpenClaw Adapter

This package contains the live OpenClaw adapter runtime for the current LightRSI OpenClaw path. Within the broader LightRSI framework, this package is the runtime adapter layer used by the TokenPilot component.

This adapter explicitly binds TokenPilot with `stabilizer`, `reduction`, and `eviction`, and contributes OpenClaw state discovery to the shared CLI/Visual product registry.

For the component-level overview, command surface, and full configuration reference, see:

- [`components/presets/tokenpilot/README.md`](../../presets/tokenpilot/README.md)
- [`components/adapters/README.md`](../README.md)
- [`components/adapters/HOSTS.md`](../HOSTS.md)

Current adapter responsibilities:

- embedded responses proxy
- stable-prefix rewriting
- request-time reduction
- tool-result persistence
- canonical history rewrite and eviction
- user-approved Context Cleaner snapshot, durable scheduling, and request-time canonical apply
- recovery protocol and recovery tool wiring

## Install

Release-style install:

```bash
cd /path/to/LightRSI/components/adapters/openclaw
npm run install:release
```

This uses OpenClaw's managed plugin installer so the declared Context Engine
capability is recorded and consented, then installs the packaged TokenPilot
runtime component into:

```text
~/.openclaw/extensions/tokenpilot
```

After install, run the adapter doctor:

```bash
cd /path/to/LightRSI/components/adapters/openclaw
npm run doctor:openclaw
```

Inside an active TokenPilot session, the equivalent self-check is:

```text
/tokenpilot doctor
```

Or use the standalone CLI:

```bash
cd /path/to/LightRSI
lightrsi openclaw doctor
```

Analyze an OpenClaw session without changing its context:

```bash
lightrsi openclaw clean --session <session-id>
```

The same flow is available inside an active OpenClaw conversation through the
plugin's native command surface:

```text
/lightrsi clean
/lightrsi clean --session <session-id>
```

The first form resolves the current conversation's mapped TokenPilot session.
If no mapping is available, pass the session id explicitly. Analysis never
applies a rewrite by itself. When the task registry is missing or behind the
canonical conversation, this explicit analysis request first classifies the
pending turns through OpenClaw's Host-managed, tool-free model completion
surface. Cleaner recommendations reuse that same Host-managed completion, so
provider credentials remain inside OpenClaw's auth store. Older Hosts
without that surface fall back to an explicitly configured `taskStateEstimator`;
classification or recommendation failure uses the conservative shared fallback
and does not make any additional task selectable.

Schedule only tasks selected from that immutable plan:

```bash
lightrsi openclaw clean --plan <plan-id> --select <task-id,...>
```

Or schedule and inspect the plan from the OpenClaw conversation:

```text
/lightrsi clean --plan <plan-id> --select <task-id,...>
/lightrsi clean --status <plan-id>
/lightrsi clean --cancel <plan-id>
```

`/tokenpilot clean` and `/tp clean` are equivalent aliases. Active, current,
and unresolved tasks remain protected by the canonical Cleaner validation.

Selection returns `scheduled` without changing the canonical transcript. Send the
next ordinary OpenClaw message to execute the plan, then query `--status` for the
`applied` receipt and measured savings. OpenClaw archives selected content before
atomically committing the canonical rewrite. A terminal plan is not executed again.

For the shared arrow-key selector, run this in a real terminal:

```bash
lightrsi openclaw clean --require-tty --session <session-id>
```

The complete plan remains above a separate selection area. Up/Down moves, Space
toggles a selectable task, Enter schedules the selection, and `q` cancels. Selection
starts empty; protected tasks remain visible and cannot be selected. The native
slash command uses explicit task IDs and does not take over OpenClaw's keyboard.
Both entry points share the same plans, schedules, and receipts under `stateDir`.
Counts remain `chars_only` where no trustworthy task-level token meter exists.

### Runtime and recovery

This version uses the existing shared `prepareScheduledClean`/`recordCleanReceipt`
API. The OpenClaw control service serializes approve/cancel with runtime execution
using the same Host session lock; it does not introduce a new shared claim API.
The capabilities factory accepts Host configuration only, not a shared control plane.

The request execution point is the active TokenPilot Context Engine's `assemble`,
before canonical synchronization. This is where OpenClaw obtains its effective
messages; a separate `before_agent_start` callback is not sufficient to protect
against subsequent assembly. `afterTurn`, `commitTurn`, and `compact` never consume
a newly scheduled plan. Pending Cleaner work and the request that consumes it
suppress automatic eviction. TokenPilot must be the active Context Engine for a
scheduled plan to execute.

An apply intent preserves previous/next revision and real rewrite evidence across
a restart. If canonical persistence succeeded but receipt persistence did not,
the next request restores the receipt without another rewrite. Status is read-only;
cancel reports `openclaw_clean_recovery_required` while an intent needs recovery.
Corrupt schedules and ambiguous recovery fail closed and preserve the Host input.
A busy session returns `openclaw_clean_session_busy` to command callers; retry after
the running operation completes. A live owner's lock is never stolen on a timeout.

For acceptance, use an isolated config/state/workspace with completed A/B and
protected C. Verify native analysis → CLI selection → native status, and the reverse;
check `scheduled` before the next message and `applied` afterward. Also verify `q`,
explicit cancel, protected rejection, repeat status, and a second request without
duplicate savings. Automated fixtures do not replace a live OpenClaw TTY recording.

Development-style install should use source build + runtime sync instead of mixing release and load-path installs. The current sanity workflow is:

1. build the package
2. sync the runtime artifact
3. validate OpenClaw config
4. restart gateway

See:

- [`README.md`](../../../README.md)
- [`components/presets/tokenpilot/README.md`](../../presets/tokenpilot/README.md)

## Build

```bash
cd /path/to/LightRSI/components/adapters/openclaw
corepack pnpm build
corepack pnpm typecheck
```

## Runtime Model Prefix

When the current TokenPilot component is active, it registers an explicit provider namespace:

```text
lightrsi/<model>
```

Example:

```text
lightrsi/gpt-5.4-mini
```

## Runtime State

The current component state directory prefers:

```text
$HOME/.openclaw/tokenpilot-state/tokenpilot/
```

Legacy installs may still be under:

```text
$HOME/.openclaw/tokenpilot-plugin-state/tokenpilot/
```

Useful files:

- `event-trace.jsonl`
- `provider-traffic.jsonl`
- `response-root-state.json`
- `sessions/<logical>/turns.jsonl`

## Debugging

When a run looks invalid, start with:

```bash
OPENCLAW_CONFIG_PATH=$HOME/.openclaw/openclaw.json openclaw config validate
tail -n 100 $HOME/.openclaw/logs/gateway.log
rg 'stable_prefix_rewrite|proxy_before_call_rewrite|proxy_after_call_rewrite|tool_result_persist_applied' \
  $HOME/.openclaw/tokenpilot-state/task-state/trace.jsonl
```

Lightweight integration self-check:

```bash
cd /path/to/LightRSI/components/adapters/openclaw
npm run doctor:openclaw
```

The runtime sanity guide lives in:

- [`../README.md`](../README.md)
- [`../HOSTS.md`](../HOSTS.md)

## Package Scripts

Primary package scripts:

```bash
corepack pnpm build
corepack pnpm typecheck
npm test
npm run doctor:openclaw
```

The package still contains a small release-helper surface under `components/adapters/openclaw/scripts/`. Benchmarking and evaluation flows live in the separate [TokenPilot experiment repository](https://github.com/Xubqpanda/TokenPilot).
