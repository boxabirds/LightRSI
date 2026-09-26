/**
 * GX-02 runtime acceptance check.
 *
 * This script deliberately uses a real DSH Cordis Context, SessionStore,
 * AgentLoop and `agent/pre-step` waterfall from a checked-out DSH tree.  The
 * only deterministic substitute is the model provider: the DSH repository's
 * keyless CLI mock keeps this check reproducible and avoids sending test
 * content or credentials to an external model.
 *
 * It is not a production-model benchmark.  Its evidence is about DSH session
 * ownership, command no-op behaviour, the next-request execution boundary,
 * canonical surface replacement, and the replay guard.
 */

import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  applySessionTaskRegistryPatch,
  createEmptySessionTaskRegistry,
  persistSessionTaskRegistry,
} from "@lightrsi/history";

import {
  createDshCleanerPreStepState,
  registerDshCleanerPreStep,
} from "../src/cleaner-pre-step.js";
import { executeContextCleanerCommand } from "../src/context-cleaner/commands.js";
import { readDshCleanerSchedule } from "../src/context-cleaner/scheduler.js";
import { surfaceRevision } from "../src/context-cleaner/snapshot.js";
import { normalizeDshConfig } from "../src/config.js";
import { registerEvictionPreStep } from "../src/eviction-engine.js";

type Module = Record<string, any>;

function requiredDshCheckout(): string {
  const argument = process.argv.find((value) => value.startsWith("--dsh-checkout="));
  if (!argument) {
    throw new Error("GX-02 requires --dsh-checkout=<absolute path to deepseek-harness>");
  }
  return resolve(argument.slice("--dsh-checkout=".length));
}

function sourceUrl(checkout: string, relativePath: string): string {
  return pathToFileURL(join(checkout, relativePath)).href;
}

function planIdFrom(text: string | undefined): string {
  const planId = /plan id: ([^\n]+)/u.exec(text ?? "")?.[1];
  assert.ok(planId, "Cleaner analysis must return an immutable plan id");
  return planId;
}

function assertSuccess(result: { kind: string; text?: string }, label: string): asserts result is { kind: "success"; text: string } {
  assert.equal(result.kind, "success", `${label} failed: ${result.text ?? "no diagnostic"}`);
  assert.equal(typeof result.text, "string", `${label} did not render command output`);
}

async function main(): Promise<void> {
  const checkout = requiredDshCheckout();
  await access(join(checkout, "packages", "core", "agent-loop", "src", "index.ts"));

  const [cordis, agentLoopModule, sessionModule, llmModule, projectionModule, tokenMeterModule, testkitModule, mockPlugin] = await Promise.all([
    import(sourceUrl(checkout, "vendor/cordis/src/index.ts")) as Promise<Module>,
    import(sourceUrl(checkout, "packages/core/agent-loop/src/index.ts")) as Promise<Module>,
    import(sourceUrl(checkout, "packages/core/session/src/index.ts")) as Promise<Module>,
    import(sourceUrl(checkout, "packages/llm/llm/src/index.ts")) as Promise<Module>,
    import(sourceUrl(checkout, "packages/session/session-projection/src/index.ts")) as Promise<Module>,
    import(sourceUrl(checkout, "packages/llm/token-meter/src/index.ts")) as Promise<Module>,
    import(sourceUrl(checkout, "packages/test-support/agent-loop-testkit/src/index.ts")) as Promise<Module>,
    import(sourceUrl(checkout, "packages/test-support/loader-smoke/tests/fixtures/cli-mock-llm.ts")) as Promise<Module>,
  ]);

  const stateRoot = await mkdtemp(join(tmpdir(), "lightrsi-gx02-real-dsh-"));
  let evidence: Record<string, unknown> | undefined;
  try {
    const ctx = new cordis.Context();
    await ctx.plugin(projectionModule.default);
    await testkitModule.mountAgentLoopTestDependencies(ctx, {
      systemPrompt: { persona: "You are a deterministic GX-02 verification agent." },
    });
    await ctx.plugin(tokenMeterModule.default);
    await ctx.plugin(agentLoopModule.default, { agents: [] });
    await ctx.plugin(mockPlugin);

    const config = normalizeDshConfig({
      enabled: true,
      stateDir: stateRoot,
      // The real automatic handler is installed below, but lifecycle model
      // estimation remains off: this check seeds its A/B/C durable registry
      // and must not need an external credential to prove Cleaner ordering.
      taskStateEstimator: { enabled: false },
      eviction: { enabled: false },
    });
    const state = createDshCleanerPreStepState();
    registerEvictionPreStep(ctx, config, undefined, {
      shouldSkipAutomaticEviction: (payload) => state.wasClaimed(payload),
    });
    registerDshCleanerPreStep(ctx, config, state);

    let unexpectedAutomaticPasses = 0;
    let scheduledPreStepObserved = false;
    let selectedSourceEventSeqs: number[] = [];
    let revisionImmediatelyAfterClean: string | undefined;
    ctx.on("agent/pre-step", async (payload: object, next: () => Promise<unknown>) => {
      // This observer is intentionally after the real Cleaner and automatic
      // eviction handlers.  During the scheduled request, a non-claimed
      // payload would mean the automatic path was not protected from a second
      // rewrite opportunity.
      if (!scheduledPreStepObserved) {
        scheduledPreStepObserved = true;
        if (!state.wasClaimed(payload as never)) unexpectedAutomaticPasses += 1;
      }
      return next();
    });
    ctx.on("session/event", (session: any, event: any) => {
      if (!Array.isArray(event.sourceEventSeqs)
        || selectedSourceEventSeqs.length === 0
        || !event.sourceEventSeqs.some((seq: number) => selectedSourceEventSeqs.includes(seq))) return;
      const landed = session.events
        .filter((candidate: any) => Array.isArray(candidate.sourceEventSeqs))
        .flatMap((candidate: any) => candidate.sourceEventSeqs)
        .filter((seq: number) => selectedSourceEventSeqs.includes(seq));
      if (new Set(landed).size === selectedSourceEventSeqs.length) {
        // This is the revision after Cleaner replacement, before AgentLoop
        // appends the later ordinary request/model response.
        revisionImmediatelyAfterClean = surfaceRevision(session);
      }
    });

    const sessionId = sessionModule.SessionId("gx02-real-dsh-session");
    const agent = ctx.agentLoop.create(sessionId, { provider: "cli-mock", model: "cli-mock" });

    const seedTurn = (turn: number, userText: string, assistantText: string) => {
      agent.session.append("turn/start", { turn });
      const user = agent.session.append("user/message", {
        id: `gx02-user-${turn}`,
        role: "user",
        content: [{ type: "text", text: userText }],
        source: { kind: "user" },
      }, { surfaceOp: "append" });
      const assistant = agent.session.append("assistant/message", {
        turn,
        step: 1,
        message: {
          id: `gx02-assistant-${turn}`,
          role: "assistant",
          content: [{ type: "text", text: assistantText }],
          source: { kind: "model" },
        },
      }, { surfaceOp: "append" });
      agent.session.append("turn/end", { turn, reason: { kind: "completed" } });
      return { user: user.seq, assistant: assistant.seq };
    };

    // A and B are completed; C remains active/protected.  Only A is selected,
    // so B and C provide independent KEEP_ME checks.
    const evict = seedTurn(1, "EVICT_ME: finished historical task input.", "EVICT_ME: finished historical task output.");
    const keepCompleted = seedTurn(2, "KEEP_ME: completed but deliberately unselected.", "KEEP_ME: retain this completed task.");
    const keepActive = seedTurn(3, "KEEP_ME_ACTIVE: task still in progress.", "KEEP_ME_ACTIVE: working state remains relevant.");
    selectedSourceEventSeqs = [evict.user, evict.assistant];

    const registry = applySessionTaskRegistryPatch(createEmptySessionTaskRegistry(agent.session.id), {
      upsertTasks: {
        "task-a": {
          taskId: "task-a",
          title: "Completed task A",
          objective: "A completed historical task selected for cleanup.",
          lifecycle: "evictable",
          evictableReason: "completed_and_moved_on",
          completionEvidence: ["Task A was delivered."],
          unresolvedQuestions: [],
          span: {
            firstTurnAbsId: `${agent.session.id}:t1`,
            lastTurnAbsId: `${agent.session.id}:t1`,
            supportingTurnAbsIds: [`${agent.session.id}:t1`],
            lastEstimatorTurnAbsId: `${agent.session.id}:t1`,
          },
        },
        "task-b": {
          taskId: "task-b",
          title: "Completed task B",
          objective: "A completed task intentionally retained in the context.",
          lifecycle: "evictable",
          evictableReason: "completed_and_moved_on",
          completionEvidence: ["Task B was delivered."],
          unresolvedQuestions: [],
          span: {
            firstTurnAbsId: `${agent.session.id}:t2`,
            lastTurnAbsId: `${agent.session.id}:t2`,
            supportingTurnAbsIds: [`${agent.session.id}:t2`],
            lastEstimatorTurnAbsId: `${agent.session.id}:t2`,
          },
        },
        "task-c": {
          taskId: "task-c",
          title: "Active task C",
          objective: "The active task that must remain protected.",
          lifecycle: "active",
          currentSubgoal: "Continue the current request.",
          completionEvidence: [],
          unresolvedQuestions: ["The user has not finished task C."],
          span: {
            firstTurnAbsId: `${agent.session.id}:t3`,
            lastTurnAbsId: `${agent.session.id}:t3`,
            supportingTurnAbsIds: [`${agent.session.id}:t3`],
            lastEstimatorTurnAbsId: `${agent.session.id}:t3`,
          },
        },
      },
      activeTaskIds: ["task-c"],
      completedTaskIds: ["task-a", "task-b"],
      evictableTaskIds: ["task-a", "task-b"],
      upsertTurnToTaskIds: {
        [`${agent.session.id}:t1`]: ["task-a"],
        [`${agent.session.id}:t2`]: ["task-b"],
        [`${agent.session.id}:t3`]: ["task-c"],
      },
    });
    await persistSessionTaskRegistry(stateRoot, registry, { expectedVersion: 0 });

    const commandContext = { commands: { register: () => () => {} } };
    const invoke = (rawInput: string) => ({
      commandId: "tokenpilot-clean",
      agent,
      rawInput,
      signal: new AbortController().signal,
    });

    const beforeRevision = surfaceRevision(agent.session);
    const beforeNodes = [...agent.session.surface.nodes];
    const beforeEvents = agent.session.events.length;

    const analysis = await executeContextCleanerCommand(commandContext, config, invoke(""));
    assertSuccess(analysis, "read-only analysis");
    assert.match(analysis.text, /\[ \] \| task-a \|/u);
    assert.match(analysis.text, /\[ \] \| task-b \|/u);
    assert.match(analysis.text, /\[-\] \| task-c \|/u);
    assert.equal(surfaceRevision(agent.session), beforeRevision, "analysis changed a real DSH surface");
    assert.equal(agent.session.events.length, beforeEvents, "analysis appended a real DSH event");

    const planId = planIdFrom(analysis.text);
    const scheduled = await executeContextCleanerCommand(commandContext, config, invoke(`--plan ${planId} --select task-a`));
    assertSuccess(scheduled, "explicit selection");
    assert.match(scheduled.text, /status: scheduled/u);
    assert.equal(surfaceRevision(agent.session), beforeRevision, "selection changed a real DSH surface");
    assert.deepEqual([...agent.session.surface.nodes], beforeNodes, "selection changed real DSH surface membership");

    const scheduledStatus = await executeContextCleanerCommand(commandContext, config, invoke(`--status ${planId}`));
    assertSuccess(scheduledStatus, "scheduled status");
    assert.match(scheduledStatus.text, /status: scheduled/u);

    // This is the required ordinary next request.  It traverses DSH's actual
    // AgentLoop and Cordis pre-step waterfall; it is not a direct invocation
    // of the Cleaner handler.
    agent.followup(llmModule.createUserMessage({
      content: [{ type: "text", text: "Please continue with the current task." }],
      source: { kind: "user" },
    }));
    await agent.whenIdle();

    const afterRequestRevision = surfaceRevision(agent.session);
    assert.ok(revisionImmediatelyAfterClean, "the scheduled real-session cleanup did not publish a canonical replacement revision");
    assert.notEqual(revisionImmediatelyAfterClean, beforeRevision, "the scheduled real-session cleanup did not change the surface revision");
    assert.equal(agent.session.surface.nodes.includes(evict.user), false, "selected EVICT_ME user content is still on the surface");
    assert.equal(agent.session.surface.nodes.includes(evict.assistant), false, "selected EVICT_ME assistant content is still on the surface");
    assert.equal(agent.session.surface.nodes.includes(keepCompleted.user), true, "unselected KEEP_ME task was removed");
    assert.equal(agent.session.surface.nodes.includes(keepCompleted.assistant), true, "unselected KEEP_ME task was removed");
    assert.equal(agent.session.surface.nodes.includes(keepActive.user), true, "active KEEP_ME task was removed");
    assert.equal(agent.session.surface.nodes.includes(keepActive.assistant), true, "active KEEP_ME task was removed");
    assert.equal(unexpectedAutomaticPasses, 0, "automatic eviction was not suppressed after Cleaner claimed this pre-step");

    const appliedStatus = await executeContextCleanerCommand(commandContext, config, invoke(`--status ${planId}`));
    assertSuccess(appliedStatus, "applied status");
    assert.match(appliedStatus.text, /status: applied/u);
    assert.match(appliedStatus.text, new RegExp(`surface: ${beforeRevision} -> ${revisionImmediatelyAfterClean}`, "u"));

    const pointer = await readDshCleanerSchedule({ stateDir: stateRoot, sessionId: agent.session.id });
    assert.equal(pointer.outcome, "terminal", "the local schedule did not become terminal");
    if (pointer.outcome === "terminal") assert.equal(pointer.record.receiptStatus, "applied");

    const cleanReplacements = () => agent.session.events.filter((event: any) =>
      Array.isArray(event.sourceEventSeqs)
      && (event.sourceEventSeqs.includes(evict.user) || event.sourceEventSeqs.includes(evict.assistant)),
    ).length;
    const replacementsAfterApply = cleanReplacements();
    assert.equal(replacementsAfterApply, 2, "the selected task did not receive exactly two canonical replacements");

    // A later ordinary request cannot replay an already terminal selection.
    agent.followup(llmModule.createUserMessage({
      content: [{ type: "text", text: "Give a concise follow-up." }],
      source: { kind: "user" },
    }));
    await agent.whenIdle();
    assert.equal(cleanReplacements(), replacementsAfterApply, "terminal Cleaner plan replayed on a later agent request");

    evidence = {
      status: "pass",
      mode: "real DSH runtime with deterministic keyless model adapter",
      dshCheckout: checkout,
      sessionId: agent.session.id,
      planId,
      receiptStatus: "applied",
      beforeRevision,
      revisionImmediatelyAfterClean,
      afterRequestRevision,
      selectedTaskIds: ["task-a"],
      replacedSourceEventSeqs: [evict.user, evict.assistant],
      retainedSourceEventSeqs: [keepCompleted.user, keepCompleted.assistant, keepActive.user, keepActive.assistant],
      automaticEvictionPassesDuringCleanerRequest: unexpectedAutomaticPasses,
      replayReplacementCount: replacementsAfterApply,
      cleanup: "temporary state root removed after verification",
    };
    await ctx.fiber.dispose();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }

  // Keep output free of the seeded prompt/response text and credentials; this
  // is suitable for attaching to the GX-02 task record.
  console.log(JSON.stringify(evidence, null, 2));
}

await main();
