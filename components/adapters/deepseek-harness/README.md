# DeepSeek Harness Context Cleaner

This adapter adds a native DeepSeek Harness command for reviewing and safely
cleaning context from completed tasks. It is deliberately two-phase:

1. `/tokenpilot-clean` analyzes the current live session and creates a plan.
2. An explicit selection only writes a durable schedule.
3. The **next normal agent request** claims that schedule and performs one
   canonical DSH surface transaction. A terminal receipt prevents replay.

Analysis, status, and cancellation never change the model-visible context.

## Configure the DSH profile

Install the adapter through its `cordis.patch.yml` as usual, then add a config
block for `tokenpilot-dsh` in the selected DSH profile. Keep `stateDir` outside
the repository and do not commit your key.

```yaml
- id: tokenpilot-dsh
  config:
    enabled: true
    stateDir: C:/Users/you/.lightrsi/dsh
    taskStateEstimator:
      enabled: true
      baseUrl: <your OpenAI-compatible API base URL>
      apiKey: <your API key>
      model: <your task-state-estimation model>
    # Keep this false for a Cleaner-only workflow: task state is still tracked,
    # but automatic eviction cannot rewrite the surface before you select work.
    eviction:
      enabled: false
```

The estimator needs `enabled`, `baseUrl`, `apiKey`, and `model`. Until it has
observed a completed task, Context Cleaner correctly reports no eligible task.

## Native workflow

1. Finish a small, self-contained task in a DSH session. Send one later normal
   request so the task-state estimator can persist its completed state.
2. Run `/tokenpilot-clean`. The response shows a plan ID and each task:
   `[ ]` is selectable, while `[-]` is protected and cannot be selected.
3. Schedule only the desired completed task:

   ```text
   /tokenpilot-clean --plan <plan-id> --select <task-id>
   ```

   The response must say `status: scheduled`; at this point the conversation
   has not changed.
4. Send an ordinary next request, for example `请用一句话总结下一步。` The
   `agent/pre-step` hook performs the one allowed canonical rewrite before
   automatic eviction and DSH compaction.
5. Verify the evidence:

   ```text
   /tokenpilot-clean --status <plan-id>
   ```

   A successful run reports `status: applied` and the prior/next surface
   revision. The same scheduled plan cannot run twice.

To cancel before that next request:

```text
/tokenpilot-clean --cancel <plan-id>
```

`/context-cleaner` remains an alias for older profiles. The native DSH command
is the supported DSH entry point.

## External CLI safety boundary (GX-01)

The DSH process owns its live Cordis `SessionStore`; an external process must
never deserialize that store, DSH events, or a model-visible message body.
During a normal `agent/pre-step` and when native analysis runs, this adapter
atomically publishes a **metadata-only** snapshot under
`<stateDir>/cleaner-snapshot/`. The persisted record has schema
`lightrsi.deepseek-harness.cleaner-snapshot/v1`, carries the canonical surface
revision and item digests/counts, and contains no raw prompt or response text.

An external integration must use the public
`createDshPersistedCleanerControlService({ stateDir })` factory. It accepts
only snapshots that have the matching schema and host ID and are fresh (five
minutes by default). A DSH Host/session that has not published a fresh snapshot,
a malformed file, inaccessible state directory, or expired snapshot is reported
as *unavailable*; the service does not invent a context. A process that exits
just after publishing remains usable only until that bounded freshness window
expires; the next live DSH `agent/pre-step` still validates the plan revision
and is the only place that can call the canonical surface transaction. The
external service can analyze a published snapshot and write a durable schedule
pointer, but it cannot rewrite a DSH surface.

This adapter exposes the safe factory for the shared CLI product; it does not
register a duplicate product CLI command itself.

## Same-host interactive-selector limitation (GX-03)

DeepSeek Harness's current command contract supplies parsed `rawInput`, while
its web terminal block is a settled-output renderer rather than an interactive
raw-key TTY. Consequently this adapter provides the reproducible native text
workflow (`/tokenpilot-clean`, then `--plan ... --select ...`) but **does not
claim an arrow-key/space/enter selector inside DSH**. Implementing that UX
requires a host-supported raw-key terminal capability or a DSH-owned web
selector. The persisted-snapshot boundary above enables the separate CLI/TTY
path without weakening DSH's surface-mutation boundary.

## Verification

From the repository root:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm --dir .\components\adapters\deepseek-harness typecheck
corepack pnpm --dir .\components\adapters\deepseek-harness test
```

Current branch validation: `typecheck` passed and `test` passed (107 tests,
including persisted-snapshot restart, freshness, no-raw-text, protected/unknown
selection rejection, and schedule-without-surface-mutation coverage).

`compatibility:smoke` also passed against the pinned local DSH
`0.1.2-alpha.3` (`dd6322d604e00eec1ba5e0c8541159906a21094a`). It verifies
the packed adapter, profile install/remove, and keyless Web startup. The smoke
deliberately does not create a model-backed Cleaner session or mutate a live
surface, so it is a package/compatibility check rather than evidence of a
production Cleaner rollout.

For the pinned DSH compatibility smoke, pass a checkout of the required DSH
revision:

```powershell
corepack pnpm --dir .\components\adapters\deepseek-harness compatibility:smoke -- --dsh-checkout="C:\path\to\deepseek-harness"
```

### GX-02 real DSH-session verification

The unit suite intentionally uses small structural session fixtures for fault
injection. For GX-02 acceptance, also run the following command against the
pinned DSH checkout:

```powershell
corepack pnpm --dir .\components\adapters\deepseek-harness gx02:real-session -- --dsh-checkout="C:\path\to\deepseek-harness"
```

It starts an isolated, **real DSH Cordis runtime** with its real `SessionStore`,
`AgentLoop`, `TokenMeter`, and `agent/pre-step` waterfall. It persists A/B
completed and C active task state, verifies that analysis and selection leave
the canonical surface revision unchanged, then sends one ordinary agent request
to perform the selected A cleanup. The JSON evidence records the before/after
revision, replaced and retained source-event IDs, the applied receipt, and the
terminal replay guard; its temporary state directory is always removed.

The model adapter in this verifier is DSH's deterministic local keyless mock.
That avoids API keys and network calls; it is **not** presented as evidence of
an external production model. The separate compatibility smoke remains the
profile install/remove and Web-startup check.
