import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeContextCleanRecommendations,
  type ContextCleanPlan,
  type ContextCleanReceipt,
} from "@lightrsi/cleaner";
import type { JsonModelClient } from "@lightrsi/runtime-core";

import {
  createOpenClawCleanRecommendationProvider,
  createOpenClawContextCleanerCommandHandler,
  handleOpenClawContextCleanCommand,
  loadOpenClawContextCleanerConfig,
} from "./context-cleaner-command.js";
import { registerTokenPilotCommand } from "../tokenpilot-command.js";
import { normalizeConfig } from "../../context-stack/integration/config-normalize.js";

const plan: ContextCleanPlan = {
  schemaVersion: 1,
  planId: "ctxclean-demo",
  hostId: "openclaw",
  sessionId: "session-demo",
  baseRevision: "revision-a",
  usedTokens: 120,
  usedChars: 480,
  protectedTokens: 20,
  protectedChars: 80,
  unassignedTokens: 0,
  unassignedChars: 0,
  tokenCountMode: "exact",
  tokenCountMethod: "fixture",
  tasks: [
    {
      taskId: "task-done",
      label: "Completed task",
      description: "Finished implementation work",
      summary: "done",
      lifecycleState: "completed",
      itemIds: ["item-1"],
      itemDigests: { "item-1": "digest-1" },
      tokenCount: 100,
      charCount: 400,
      tokenPercent: 83.3,
      recommendation: "clean",
      reasonCodes: ["task_completed"],
      selectable: true,
    },
    {
      taskId: "task-active",
      label: "Active task",
      description: "Current work must stay",
      summary: "active",
      lifecycleState: "active",
      itemIds: ["item-2"],
      itemDigests: { "item-2": "digest-2" },
      tokenCount: 20,
      charCount: 80,
      tokenPercent: 16.7,
      recommendation: "protected",
      reasonCodes: ["deterministic_protection"],
      selectable: false,
    },
  ],
  createdAt: "2026-09-09T00:00:00.000Z",
};

const appliedReceipt: ContextCleanReceipt = {
  schemaVersion: 1,
  planId: plan.planId,
  hostId: "openclaw",
  sessionId: plan.sessionId,
  status: "applied",
  selectedTaskIds: ["task-done"],
  estimatedSavedTokens: 100,
  estimatedSavedChars: 400,
  appliedSavedTokens: 100,
  appliedSavedChars: 400,
  tokenCountMode: "exact",
  deferredTaskIds: [],
  reasons: [],
  updatedAt: "2026-09-09T00:00:01.000Z",
  fallbackUsed: false,
  evidence: {
    previousRevision: "revision-a",
    nextRevision: "revision-b",
    operationIds: ["operation-1"],
    itemIds: ["item-1"],
  },
};

function backend(overrides: Record<string, unknown> = {}) {
  return {
    stateDir: "C:/state",
    async analyze() { return plan; },
    async readPlan() { return plan; },
    async approve() { return appliedReceipt; },
    async readReceipt() { return appliedReceipt; },
    async cancel() { return { ...appliedReceipt, status: "cancelled" }; },
    ...overrides,
  } as any;
}

test("native clean analyzes the current OpenClaw session without applying changes", async () => {
  let analyzedSessionId = "";
  let approved = false;
  const result = await handleOpenClawContextCleanCommand({
    ctx: { sessionId: "session-demo" },
    rawArgs: "",
    backend: backend({
      async analyze(sessionId: string) {
        analyzedSessionId = sessionId;
        return plan;
      },
      async approve() {
        approved = true;
        return appliedReceipt;
      },
    }),
  });

  assert.equal(analyzedSessionId, "session-demo");
  assert.equal(approved, false);
  assert.match(result.text, /Context clean plan: ctxclean-demo/);
  assert.match(result.text, /```text\n/);
  assert.match(result.text, /TASK\s+DESCRIPTION\s+SIZE\s+SHARE\s+ADVICE\s+RISK \/ REASONS/);
  assert.match(result.text, /100 tok\s+83\.3%\s+clean\s+low/);
  assert.match(result.text, /Task details:/);
  assert.match(result.text, /Recommended selection estimate: 100 tok/);
  assert.match(result.text, /1\. task-done - Completed task/);
  assert.match(result.text, /Schedule selected tasks: \/lightrsi clean --plan ctxclean-demo --select/);
  assert.match(result.text, /No changes applied/);
  assert.match(result.text, /Interactive selection in this terminal:/);
  assert.match(
    result.text,
    /lightrsi openclaw clean --require-tty --session session-demo/,
  );
  assert.match(result.text, /no recent-session guess is used/);
});

test("native clean carries an explicit OpenClaw session into the terminal selector", async () => {
  let analyzedSessionId = "";
  const result = await handleOpenClawContextCleanCommand({
    ctx: { sessionId: "wrong-current-session" },
    rawArgs: "--session explicit-session",
    backend: backend({
      async analyze(sessionId: string) {
        analyzedSessionId = sessionId;
        return { ...plan, sessionId };
      },
    }),
  });

  assert.equal(analyzedSessionId, "explicit-session");
  assert.match(
    result.text,
    /lightrsi openclaw clean --require-tty --session explicit-session/,
  );
  assert.doesNotMatch(result.text, /wrong-current-session/);
});

test("native clean renders session ids as safe terminal arguments", async () => {
  const render = async (sessionId: string) => (await handleOpenClawContextCleanCommand({
    ctx: { sessionId },
    rawArgs: "",
    backend: backend({ async analyze() { return { ...plan, sessionId }; } }),
  })).text;

  const unusual = await render(`session with "quotes" $HOME; echo pwned 'single' 中文`);
  assert.match(unusual, /POSIX shell: .*'session with "quotes" \$HOME; echo pwned '"'"'single'"'"' 中文'/);
  assert.match(unusual, /PowerShell: .*'session with "quotes" \$HOME; echo pwned ''single'' 中文'/);
  assert.doesNotMatch(unusual, /Run: .*--session session with/);

  const control = await render("session-safe\necho pwned");
  assert.match(control, /terminal command unavailable.*control characters/i);
  assert.doesNotMatch(control, /--session session-safe/);
  assert.match(control, /Host\/session: openclaw \/ session-safe\\u000aecho pwned/);
  assert.doesNotMatch(control, /Host\/session: openclaw \/ session-safe\necho pwned/);

  const quoted = await render("%PATH%");
  assert.match(
    quoted,
    /Run \(POSIX shell or PowerShell\): lightrsi openclaw clean --require-tty --session '%PATH%'/,
  );
  assert.doesNotMatch(quoted, /Run: .*--session %PATH%/);

  const rejected = await render("--wrong-session");
  assert.match(rejected, /terminal command unavailable.*reserved option prefix/i);
  assert.doesNotMatch(rejected, /--session '--wrong-session'/);
});

test("native clean forwards only the explicit plan task selection", async () => {
  let approvedPlanId = "";
  let approvedTaskIds: string[] = [];
  const result = await handleOpenClawContextCleanCommand({
    ctx: {},
    rawArgs: "--plan ctxclean-demo --select task-done",
    backend: backend({
      async approve(planId: string, taskIds: string[]) {
        approvedPlanId = planId;
        approvedTaskIds = taskIds;
        return appliedReceipt;
      },
    }),
  });

  assert.equal(approvedPlanId, "ctxclean-demo");
  assert.deepEqual(approvedTaskIds, ["task-done"]);
  assert.match(result.text, /Context clean applied/);
  assert.match(result.text, /Applied savings: 100 tok/);
  assert.match(result.text, /Fallback count: 0/);
  assert.match(result.text, /Apply timing: next Host request \(completed\)\./);
});

test("native clean reads status and cancels through the canonical backend", async () => {
  let statusPlanId = "";
  let cancelledPlanId = "";
  const cleanBackend = backend({
    async readReceipt(planId: string) {
      statusPlanId = planId;
      return appliedReceipt;
    },
    async cancel(planId: string) {
      cancelledPlanId = planId;
      return {
        ...appliedReceipt,
        status: "cancelled",
        appliedSavedTokens: undefined,
        appliedSavedChars: undefined,
        fallbackUsed: true,
        evidence: undefined,
        reasons: ["cancelled_by_user"],
      };
    },
  });

  const status = await handleOpenClawContextCleanCommand({
    ctx: {}, rawArgs: "--status ctxclean-demo", backend: cleanBackend,
  });
  const cancelled = await handleOpenClawContextCleanCommand({
    ctx: {}, rawArgs: "--cancel ctxclean-demo", backend: cleanBackend,
  });

  assert.equal(statusPlanId, "ctxclean-demo");
  assert.equal(cancelledPlanId, "ctxclean-demo");
  assert.match(status.text, /Context clean applied/);
  assert.match(status.text, /Applied savings: 100 tok/);
  assert.match(status.text, /Apply timing: next Host request \(completed\)\./);
  assert.match(cancelled.text, /Context clean cancelled/);
  assert.match(cancelled.text, /Fallback count: 1/);
});

test("native clean distinguishes scheduled savings from applied savings", async () => {
  const scheduledReceipt: ContextCleanReceipt = {
    ...appliedReceipt,
    status: "scheduled",
    appliedSavedTokens: undefined,
    appliedSavedChars: undefined,
    evidence: undefined,
  };
  const result = await handleOpenClawContextCleanCommand({
    ctx: {},
    rawArgs: "--status ctxclean-demo",
    backend: backend({ async readReceipt() { return scheduledReceipt; } }),
  });

  assert.match(result.text, /Context clean scheduled/);
  assert.match(result.text, /Estimated savings: 100 tok/);
  assert.match(result.text, /Scheduled savings: 100 tok/);
  assert.match(result.text, /Applied savings: not applied/);
  assert.match(result.text, /Fallback count: 0/);
  assert.match(result.text, /Apply timing: next Host request\./);
});

test("native clean preserves chars-only units for zero-value receipts", async () => {
  const receipt: ContextCleanReceipt = {
    ...appliedReceipt,
    status: "cancelled",
    selectedTaskIds: [],
    estimatedSavedTokens: 0,
    estimatedSavedChars: 0,
    appliedSavedTokens: undefined,
    appliedSavedChars: undefined,
    tokenCountMode: "chars_only",
    evidence: undefined,
    fallbackUsed: true,
    reasons: ["cancelled_by_user"],
  };
  const result = await handleOpenClawContextCleanCommand({
    ctx: {},
    rawArgs: "--status ctxclean-demo",
    backend: backend({ async readReceipt() { return receipt; } }),
  });

  assert.match(result.text, /Estimated savings: 0 chars/);
  assert.doesNotMatch(result.text, /Estimated savings: 0 tok/);
});

test("native command registration preserves aliases and exposes clean help", async () => {
  const registered: Array<{ name: string; handler(ctx: any): Promise<{ text: string }> }> = [];
  const api = {
    registerCommand(spec: any) { registered.push(spec); },
    runtime: {
      config: {
        loadConfig: async () => ({}),
        writeConfigFile: async () => undefined,
      },
    },
  };
  registerTokenPilotCommand(api, {});

  assert.deepEqual(registered.map((spec) => spec.name), ["tokenpilot", "lightrsi", "tp"]);
  const command = registered.find((spec) => spec.name === "lightrsi");
  assert.ok(command);
  const cleanHelp = await command.handler({ args: "clean --help" });
  assert.match(cleanHelp.text, /\/lightrsi clean --plan/);
  assert.match(cleanHelp.text, /lightrsi openclaw clean --require-tty --session/);
  const generalHelp = await command.handler({ args: "help" });
  assert.match(generalHelp.text, /Context Cleaner:/);
});

test("native clean reads current OpenClaw config without the removed runtime loader", async () => {
  const currentConfig = { plugins: { entries: { tokenpilot: { enabled: true } } } };
  assert.equal(loadOpenClawContextCleanerConfig({ config: currentConfig }), currentConfig);
});

test("native clean retains the legacy OpenClaw config loader fallback", async () => {
  const legacyConfig = { plugins: { entries: {} } };
  const legacyConfigApi = {
    marker: "legacy",
    loadConfig(this: { marker: string }) {
      assert.equal(this.marker, "legacy");
      return legacyConfig;
    },
  };

  assert.equal(
    await loadOpenClawContextCleanerConfig({ runtime: { config: legacyConfigApi } }),
    legacyConfig,
  );
});

test("native clean fails closed when OpenClaw exposes no config surface", () => {
  assert.throws(
    () => loadOpenClawContextCleanerConfig({}),
    /clean_config_unavailable/,
  );
});

test("native clean recommendations use the Host-managed model without API credentials", async () => {
  let requests = 0;
  const modelClient: JsonModelClient = {
    async request() {
      requests += 1;
      return {
        text: JSON.stringify({
          tasks: [{
            taskId: "task-done",
            label: "Completed task",
            description: "Finished implementation work",
            summary: "done",
            recommendation: "clean",
            reasonCodes: ["task_completed"],
            confidence: 0.95,
          }],
        }),
      };
    },
  };
  const provider = createOpenClawCleanRecommendationProvider(
    normalizeConfig({ taskStateEstimator: { enabled: false } }),
    modelClient,
  );

  assert.ok(provider);
  const result = await analyzeContextCleanRecommendations({
    tasks: [plan.tasks[0]!],
    provider,
  });

  assert.equal(requests, 1);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.tasks[0]?.recommendation, "clean");
  assert.equal(result.tasks[0]?.selectable, true);
});

test("native clean handler returns actionable usage for invalid arguments", async () => {
  const handler = createOpenClawContextCleanerCommandHandler({
    loadConfig: async () => ({}),
    createBackend: () => backend(),
  });
  const result = await handler({}, "--select task-done");
  assert.match(result.text, /Context clean error: clean_plan_missing/);
  assert.match(result.text, /\/lightrsi clean --status/);
  const malformed = await handler({}, "--plan plan --select task-done,,task-other");
  assert.match(malformed.text, /clean_selection_malformed/);
});
