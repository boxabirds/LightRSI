/**
 * Regression matrix: opencode/src/runtime.ts + opencode/src/plugin.ts
 *
 * Plugin module
 *   M1 default export is exactly { id: "tokenpilot", server }, no other exports
 *   M2 server() returns the two transform hooks and dispose
 * Config loading (ensureConfig)
 *   G1 disabled config → both hooks leave output untouched
 *   G2 config file edits are picked up on the next hook call (mtime/size stamp)
 *   G3 loader throws → hooks fail open (output untouched), warning logged
 * experimental.chat.system.transform
 *   Y1 volatile line moved to the tail (shared stabilizer, developer) + recovery protocol
 *   Y2 no volatile lines → recovery protocol appended only
 *   Y3 idempotent: running twice does not duplicate the protocol
 *   Y4 dynamicContextTarget=user → developer behaviour, one warning logged
 *   Y5 stabilizer off → volatile line stays; protocol still appended
 *   Y6 malformed output (no system array / non-string) → untouched, no throw
 * experimental.chat.messages.transform
 *   R1 large tool output → only that part is replaced (cloned); text equals the shared
 *      reduction run directly; latest-session ref and a turn binding are written
 *   R2 repeated call on a fresh copy of the same history → byte-identical output (memo)
 *   R3 small history → no replacements (array elements keep identity)
 *   R4 no session id → untouched
 *   R5 malformed messages → untouched, no throw
 *   R6 reduction module off → no replacements
 * Eviction overlay (messages.transform)
 *   E1 default config → estimator never created, no overlay written
 *   E2 enabled + completed earlier turn → overlay saved and applied (stub text in the part)
 *   E3 a later request re-applies the stored overlay without calling the estimator
 *   E4 overlay save failure → no eviction applied this request (deferred)
 *   E5 estimator throws → eviction skipped and logged, reduction still applied
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { SemanticTaskUpdate, TaskStateEstimator } from "@lightrsi/eviction";
import { createEmptySessionTaskRegistry, type SessionTaskRegistry } from "@lightrsi/history";
import { latestSessionPath, loadRecentTurnBindings } from "@lightrsi/host-adapter";

import { canonicalRecoveryProtocolText, createCanonicalEnvelope } from "../../shared/canonical/before-call.js";
import { adapterLogPath } from "../../shared/canonical/logger.js";
import { reduceCanonicalEnvelope } from "../../shared/canonical/reduction.js";
import { decodeOpenCodeMessages } from "../src/codec.js";
import { normalizeTokenPilotOpenCodeConfig } from "../src/config.js";
import type { OcMessageWithParts, OcToolPart } from "../src/opencode-types.js";
import { overlayPath } from "../src/overlay.js";
import * as pluginModule from "../src/plugin.js";
import { OpenCodeTokenPilotRuntime, type OpenCodeRuntimeDependencies } from "../src/runtime.js";

const S = "ses_rt";
const BIG = Array.from({ length: 3000 }, (_, i) => `line ${i} output from build step ok`).join("\n");
const SYSTEM = "You are opencode.\nToday's date: Mon Sep 28 2026\nWorking directory: /work";

async function setup(raw: Record<string, unknown> = {}, deps: OpenCodeRuntimeDependencies = {}) {
  const dir = await mkdtemp(join(tmpdir(), "tp-oc-rt-"));
  const configPath = join(dir, "tokenpilot.json");
  await writeFile(configPath, JSON.stringify({ stateDir: join(dir, "state"), ...raw }));
  const runtime = new OpenCodeTokenPilotRuntime({ configPath, ...deps });
  const hooks = runtime.hooks();
  const stateDir = join(dir, "state");
  return { dir, configPath, stateDir, runtime, hooks };
}

function history(output = BIG, suffix = ""): OcMessageWithParts[] {
  return [
    { info: { id: `msg_u1${suffix}`, sessionID: S, role: "user", model: { providerID: "llama", modelID: "qwen3" } }, parts: [{ id: "p_u1", sessionID: S, messageID: "msg_u1", type: "text", text: "fix the build" }] },
    {
      info: { id: "msg_a1", sessionID: S, role: "assistant" },
      parts: [
        { id: "p_t1", sessionID: S, messageID: "msg_a1", type: "tool", callID: "call_1", tool: "bash", state: { status: "completed", input: { command: "make" }, output, title: "make", metadata: {}, time: { start: 1, end: 2 } } },
      ],
    },
  ];
}

const system = (text = SYSTEM) => ({ system: [text] });

describe("plugin module", () => {
  it("M1 default export only, shaped { id, server }", () => {
    assert.deepEqual(Object.keys(pluginModule), ["default"]);
    assert.equal(pluginModule.default.id, "tokenpilot");
    assert.equal(typeof pluginModule.default.server, "function");
  });
  it("M2 server returns the transform hooks", async () => {
    const hooks = await pluginModule.default.server({ directory: "/w", worktree: "/w" });
    assert.deepEqual(Object.keys(hooks).sort(), ["dispose", "experimental.chat.messages.transform", "experimental.chat.system.transform"]);
  });
});

describe("config loading", () => {
  it("G1 a disabled config leaves both outputs untouched", async () => {
    const env = await setup({ enabled: false });
    const sys = system();
    await env.hooks["experimental.chat.system.transform"]!({ sessionID: S, model: {} }, sys);
    assert.equal(sys.system[0], SYSTEM);
    const messages = history();
    const before = [...messages];
    await env.hooks["experimental.chat.messages.transform"]!({}, { messages });
    messages.forEach((m, i) => assert.equal(m, before[i]));
  });
  it("G2 config edits are picked up on the next call", async () => {
    const env = await setup({ enabled: false });
    const first = system();
    await env.hooks["experimental.chat.system.transform"]!({ sessionID: S, model: {} }, first);
    assert.equal(first.system[0], SYSTEM);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(env.configPath, JSON.stringify({ stateDir: env.stateDir, enabled: true, logLevel: "debug" }));
    const second = system();
    await env.hooks["experimental.chat.system.transform"]!({ sessionID: S, model: {} }, second);
    assert.notEqual(second.system[0], SYSTEM);
  });
  it("G3 a throwing loader fails open", async () => {
    const env = await setup({}, { loadConfig: async () => { throw new Error("broken config"); } });
    const sys = system();
    await assert.doesNotReject(env.hooks["experimental.chat.system.transform"]!({ sessionID: S, model: {} }, sys));
    assert.equal(sys.system[0], SYSTEM);
  });
});

describe("experimental.chat.system.transform", () => {
  it("Y1 moves the volatile line to the tail and appends the recovery protocol", async () => {
    const env = await setup();
    const sys = system();
    await env.hooks["experimental.chat.system.transform"]!({ sessionID: S, model: { id: "qwen3" } }, sys);
    assert.equal(sys.system[0], `You are opencode.\nWorking directory: /work\n\nToday's date: Mon Sep 28 2026\n\n${canonicalRecoveryProtocolText()}`);
    assert.equal(sys.system.length, 1);
  });
  it("Y2 without volatile lines only the protocol is appended", async () => {
    const env = await setup();
    const sys = system("You are opencode.");
    await env.hooks["experimental.chat.system.transform"]!({ sessionID: S, model: {} }, sys);
    assert.equal(sys.system[0], `You are opencode.\n\n${canonicalRecoveryProtocolText()}`);
  });
  it("Y3 is idempotent", async () => {
    const env = await setup();
    const sys = system("You are opencode.");
    await env.hooks["experimental.chat.system.transform"]!({ sessionID: S, model: {} }, sys);
    const once = sys.system[0];
    await env.hooks["experimental.chat.system.transform"]!({ sessionID: S, model: {} }, sys);
    assert.equal(sys.system[0], once);
  });
  it("Y4 user target falls back to developer with one warning", async () => {
    const env = await setup({ hooks: { dynamicContextTarget: "user" } });
    for (let i = 0; i < 2; i += 1) {
      const sys = system();
      await env.hooks["experimental.chat.system.transform"]!({ sessionID: S, model: {} }, sys);
      assert.ok(sys.system[0]!.includes("\n\nToday's date: Mon Sep 28 2026\n\n"));
    }
    const log = await readFile(adapterLogPath(env.stateDir), "utf8");
    assert.equal(log.match(/dynamicContextTarget=user is not supported/g)?.length, 1);
  });
  it("Y5 stabilizer off keeps the volatile line in place", async () => {
    const env = await setup({ modules: { stabilizer: false } });
    const sys = system();
    await env.hooks["experimental.chat.system.transform"]!({ sessionID: S, model: {} }, sys);
    assert.equal(sys.system[0], `${SYSTEM}\n\n${canonicalRecoveryProtocolText()}`);
  });
  it("Y6 malformed output is left alone", async () => {
    const env = await setup();
    const empty = { system: [] as string[] };
    await env.hooks["experimental.chat.system.transform"]!({ sessionID: S, model: {} }, empty);
    assert.deepEqual(empty.system, []);
    await assert.doesNotReject(env.hooks["experimental.chat.system.transform"]!({ sessionID: S, model: {} }, null as unknown as { system: string[] }));
  });
});

describe("experimental.chat.messages.transform", () => {
  it("R1 reduces the large output exactly as the shared pipeline would", async () => {
    const env = await setup();
    const messages = history();
    const original = [...messages];
    await env.hooks["experimental.chat.messages.transform"]!({}, { messages });
    assert.equal(messages[0], original[0]);
    assert.notEqual(messages[1], original[1]);
    const output = ((messages[1]!.parts[0] as OcToolPart).state as { output: string }).output;
    const direct = await reduceCanonicalEnvelope({
      envelope: createCanonicalEnvelope({ hostId: "opencode", displayName: "OpenCode", sessionId: S, model: "qwen3", messages: decodeOpenCodeMessages(history()).messages }),
      config: normalizeTokenPilotOpenCodeConfig({ stateDir: env.stateDir }),
    });
    const directText = (direct.envelope.messages[2]!.content as Array<{ text: string }>)[0]!.text;
    const strip = (t: string) => t.replace(/\nArchive: [^\n]*$/, "");
    assert.equal(strip(output), strip(directText));
    assert.equal(((original[1]!.parts[0] as OcToolPart).state as { output: string }).output, BIG, "stored part mutated");
    assert.equal(JSON.parse(await readFile(latestSessionPath(env.stateDir), "utf8")).sessionId, S);
    const bindings = await loadRecentTurnBindings<{ reductionSavedChars: number }>(env.stateDir, S);
    assert.equal(bindings.at(-1)?.reductionSavedChars, BIG.length - output.length);
  });
  it("R2 a repeated call is byte-identical", async () => {
    const env = await setup();
    const first = history();
    await env.hooks["experimental.chat.messages.transform"]!({}, { messages: first });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = history();
    await env.hooks["experimental.chat.messages.transform"]!({}, { messages: second });
    assert.equal(JSON.stringify(second), JSON.stringify(first));
  });
  it("R3 a small history keeps every element", async () => {
    const env = await setup();
    const messages = history("small");
    const before = [...messages];
    await env.hooks["experimental.chat.messages.transform"]!({}, { messages });
    messages.forEach((m, i) => assert.equal(m, before[i]));
  });
  it("R4 no session id leaves messages alone", async () => {
    const env = await setup();
    const messages = history().map((m) => ({ ...m, info: { ...m.info, sessionID: "" } }));
    const before = [...messages];
    await env.hooks["experimental.chat.messages.transform"]!({}, { messages });
    messages.forEach((m, i) => assert.equal(m, before[i]));
  });
  it("R5 malformed messages never throw", async () => {
    const env = await setup();
    await assert.doesNotReject(env.hooks["experimental.chat.messages.transform"]!({}, { messages: [null, 1] as unknown as OcMessageWithParts[] }));
    await assert.doesNotReject(env.hooks["experimental.chat.messages.transform"]!({}, null as unknown as { messages: OcMessageWithParts[] }));
  });
  it("R6 reduction off makes no replacements", async () => {
    const env = await setup({ modules: { reduction: false } });
    const messages = history();
    const before = [...messages];
    await env.hooks["experimental.chat.messages.transform"]!({}, { messages });
    messages.forEach((m, i) => assert.equal(m, before[i]));
  });
});

describe("eviction overlay", () => {
  const TASK: SemanticTaskUpdate = {
    taskId: "task-build", objective: "fix the build", lifecycle: "completed",
    coveredTurnAbsIds: [`${S}:t1`], completionEvidence: ["build passed"],
  };
  const EVICTION_ON = {
    modules: { eviction: true },
    eviction: { enabled: true, minBlockChars: 256 },
    taskStateEstimator: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" },
  };
  function store() {
    let current: SessionTaskRegistry = createEmptySessionTaskRegistry(S);
    return { load: () => current, persist: (registry: SessionTaskRegistry) => { current = registry; } };
  }
  function twoTurns(): OcMessageWithParts[] {
    return [
      ...history(),
      { info: { id: "msg_u2", sessionID: S, role: "user", model: { providerID: "llama", modelID: "qwen3" } }, parts: [{ id: "p_u2", sessionID: S, messageID: "msg_u2", type: "text", text: "now the docs" }] },
    ];
  }
  const partOutput = (messages: OcMessageWithParts[]) => ((messages[1]!.parts[0] as OcToolPart).state as { output: string }).output;

  it("E1 the default config never creates an estimator", async () => {
    let created = false;
    const env = await setup({}, { createEstimator: () => { created = true; return undefined; } });
    await env.hooks["experimental.chat.messages.transform"]!({}, { messages: twoTurns() });
    assert.equal(created, false);
    assert.equal(existsSync(overlayPath(env.stateDir, S)), false);
  });
  it("E2 a completed earlier turn is evicted through the overlay", async () => {
    const env = await setup(EVICTION_ON, { createEstimator: (): TaskStateEstimator => ({ estimate: () => ({ baseVersion: 0, taskUpdates: [TASK] }) }), registryStore: store() });
    const messages = twoTurns();
    await env.hooks["experimental.chat.messages.transform"]!({}, { messages });
    assert.ok(partOutput(messages).startsWith("[evicted: tool_result part:p_t1]"));
    const overlay = JSON.parse(await readFile(overlayPath(env.stateDir, S), "utf8"));
    assert.deepEqual(Object.keys(overlay.entries), ["part:p_t1"]);
  });
  it("E3 later requests re-apply the stored overlay without estimating again", async () => {
    let calls = 0;
    const registry = store();
    const env = await setup(EVICTION_ON, { createEstimator: () => ({ estimate: () => { calls += 1; return { baseVersion: 0, taskUpdates: [TASK] }; } }), registryStore: registry });
    const first = twoTurns();
    await env.hooks["experimental.chat.messages.transform"]!({}, { messages: first });
    const second = twoTurns();
    await env.hooks["experimental.chat.messages.transform"]!({}, { messages: second });
    assert.equal(calls, 1);
    assert.equal(partOutput(second), partOutput(first));
  });
  it("E4 an overlay save failure defers the eviction", async () => {
    const env = await setup(EVICTION_ON, { createEstimator: () => ({ estimate: () => ({ baseVersion: 0, taskUpdates: [TASK] }) }), registryStore: store() });
    const blocked = dirname(overlayPath(env.stateDir, S));
    await mkdir(dirname(blocked), { recursive: true });
    await writeFile(blocked, "not a directory");
    const messages = twoTurns();
    await env.hooks["experimental.chat.messages.transform"]!({}, { messages });
    assert.ok(!partOutput(messages).startsWith("[evicted:"));
    await chmod(blocked, 0o644);
  });
  it("E5 a throwing estimator skips eviction but reduction still runs", async () => {
    const env = await setup(EVICTION_ON, { createEstimator: () => ({ estimate: () => { throw new Error("estimator down"); } }), registryStore: store() });
    const messages = twoTurns();
    await env.hooks["experimental.chat.messages.transform"]!({}, { messages });
    const output = partOutput(messages);
    assert.ok(!output.startsWith("[evicted:"));
    assert.ok(output.length < BIG.length, "reduction should still apply");
    assert.match(await readFile(adapterLogPath(env.stateDir), "utf8"), /eviction failed open Error: estimator down/);
  });
});
