/**
 * Regression matrix: pi/src/extension.ts + pi/src/runtime.ts
 *
 * Registration
 *   X1 registers exactly session_start, session_shutdown, before_agent_start, context,
 *      turn_end and one tool named memory_fault_recover
 *   X2 the factory does no I/O (config is not loaded until session_start)
 * session_start
 *   S1 loads config, binds the pi session id, writes the latest-session ref
 *   S2 disabled config → nothing written; later hooks are no-ops
 *   S3 config loader throws → fails open; later hooks are no-ops
 *   S4 per-session caches (disclosed-read memo, pending user prefix) are reset
 *   S5 missing session id → stable fallback id
 * before_agent_start
 *   B1 before session_start / disabled → undefined, options untouched
 *   B2 no volatile lines → only the recovery section is added
 *   B3 developer target: volatile lines leave appendSystemPrompt / sections / contextFiles
 *      (text equals the shared rewrite's forwardedText) and land in tokenpilot_dynamic
 *   B4 user target: no dynamic section; lines queued for the first user message
 *   B5 stabilizer off: volatile lines stay; recovery section still added
 *   B6 TOKENPILOT_DISABLE_RECOVERY_PROTOCOL → no recovery section
 *   B7 never returns systemPrompt (no forced full-prompt replacement)
 *   B8 duplicate volatile lines are collected once
 *   B9 malformed options → fail open, no throw
 * context
 *   C1 disabled → undefined
 *   C2 nothing to reduce → undefined (pi keeps its own array)
 *   C3 large tool output → only that toolResult is replaced; text equals the shared
 *      reduction run directly; a turn binding records total and per-pass savings
 *   C4 a second identical request returns byte-identical messages
 *   C5 user target → first real user message prefixed request-locally; input untouched
 *   C6 reduction off but prefix pending → only the prefix is applied
 *   C7 malformed messages → undefined, no throw
 *   C8 a trimmed file read stays byte-identical on the next request in the same
 *      process after another tool turn is appended (regression: live smoke run sent it
 *      untrimmed as a "repeat read" → prefix-cache miss)
 *   C9 a restarted pi process (new runtime, same stateDir + session) sends the
 *      byte-identical history (archive paths are content-derived)
 *   C10 disclosed-read memo save failure → the reduced history is still returned,
 *      warning logged
 * turn_end (eviction)
 *   T1 default config (eviction off) → undefined, estimator never created
 *   T2 enabled + completed earlier turn → context_edit drafts for evicted entry ids,
 *      replacement shaped for the target role; current turn untouched
 *   T3 estimator unavailable → undefined
 *   T4 empty projection → undefined
 *   T5 estimator throws → undefined (fail open), warning logged
 *   T6 host binding without eviction → undefined even when fully configured
 * memory_fault_recover tool
 *   R1 name, description and schema match the shared MCP tool
 *   R2 known dataKey → archived text and details
 *   R3 unknown dataKey → not-found text, details.error, no throw
 *   R4 missing dataKey → "Missing required parameter"
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SemanticTaskUpdate, TaskStateEstimator } from "@lightrsi/eviction";
import { createEmptySessionTaskRegistry, type SessionTaskRegistry } from "@lightrsi/history";
import { latestSessionPath, loadRecentTurnBindings } from "@lightrsi/host-adapter";
import { handleMcpRequest } from "@lightrsi/mcp";
import { rewriteTextForStablePrefix } from "@lightrsi/stabilizer";

import { createCanonicalEnvelope } from "../../shared/canonical/before-call.js";
import { reduceCanonicalEnvelope } from "../../shared/canonical/reduction.js";
import { adapterLogPath } from "../../shared/canonical/logger.js";
import { decodePiMessages } from "../src/codec.js";
import { normalizeTokenPilotPiConfig } from "../src/config.js";
import { registerTokenPilotPiExtension } from "../src/extension.js";
import type {
  PiAgentMessage,
  PiEventMap,
  PiExtensionAPI,
  PiExtensionContext,
  PiProjectedSessionEntry,
  PiToolDefinition,
} from "../src/pi-types.js";
import { PI_DYNAMIC_SECTION, PI_RECOVERY_SECTION, type PiRuntimeDependencies } from "../src/runtime.js";

const SESSION = "pi-session-1";
const BIG = Array.from({ length: 3000 }, (_, i) => `line ${i} output from build step ok`).join("\n");
const VOLATILE = "Project rules.\nCurrent date: 2026-09-28\nKeep diffs small.";

type Handler = (event: unknown, ctx: PiExtensionContext) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler>();
  const tools: PiToolDefinition[] = [];
  const api: PiExtensionAPI = {
    on(event, handler) {
      handlers.set(event, handler as Handler);
      return () => undefined;
    },
    registerTool(tool) {
      tools.push(tool);
    },
  };
  return { api, handlers, tools };
}

function ctx(sessionId: string | undefined = SESSION): PiExtensionContext {
  return {
    cwd: "/work",
    sessionManager: {
      getCwd: () => "/work",
      getSessionId: () => sessionId as string,
      getSessionFile: () => undefined,
      getBranch: () => [],
    },
    model: { id: "qwen3" },
  };
}

async function stateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tp-pi-"));
}

async function setup(raw: Record<string, unknown> = {}, deps: PiRuntimeDependencies = {}) {
  const dir = await stateDir();
  const config = normalizeTokenPilotPiConfig({ stateDir: dir, ...raw });
  const pi = fakePi();
  let loads = 0;
  const runtime = registerTokenPilotPiExtension(pi.api, {
    loadConfig: async () => { loads += 1; return config; },
    ...deps,
  });
  const call = <K extends keyof PiEventMap>(name: K, event: PiEventMap[K], c = ctx()) =>
    Promise.resolve(pi.handlers.get(name)!(event, c)) as Promise<unknown>;
  return { dir, config, pi, runtime, call, loads: () => loads };
}

function promptEvent(patch: Partial<PiEventMap["before_agent_start"]["systemPromptOptions"]> = {}): PiEventMap["before_agent_start"] {
  return {
    type: "before_agent_start",
    prompt: "go",
    systemPrompt: "rendered",
    systemPromptOptions: { appendSystemPrompt: "", sections: {}, contextFiles: [], ...patch },
  };
}

function transcript(output = BIG): PiAgentMessage[] {
  return [
    { role: "user", content: "fix the build", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "make" } }], timestamp: 2 },
    { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: output }], isError: false, timestamp: 3 },
  ];
}

const stripArchive = (text: string) => text.replace(/\nArchive: [^\n]*$/, "\nArchive: <path>");

describe("registration", () => {
  it("X1 registers the five lifecycle handlers and the recovery tool", async () => {
    const { pi } = await setup();
    assert.deepEqual([...pi.handlers.keys()].sort(), ["before_agent_start", "context", "session_shutdown", "session_start", "turn_end"]);
    assert.deepEqual(pi.tools.map((tool) => tool.name), ["memory_fault_recover"]);
  });
  it("X2 the factory does not load config", async () => {
    const { loads } = await setup();
    assert.equal(loads(), 0);
  });
});

describe("session_start", () => {
  it("S1 loads config, binds the session and writes the latest-session ref", async () => {
    const env = await setup();
    await env.call("session_start", { type: "session_start", reason: "startup" });
    assert.equal(env.loads(), 1);
    assert.equal(env.runtime.sessionId, SESSION);
    assert.equal(JSON.parse(await readFile(latestSessionPath(env.dir), "utf8")).sessionId, SESSION);
  });
  it("S2 a disabled config writes nothing and later hooks are no-ops", async () => {
    const env = await setup({ enabled: false });
    await env.call("session_start", { type: "session_start", reason: "startup" });
    assert.equal(existsSync(latestSessionPath(env.dir)), false);
    const event = promptEvent();
    assert.equal(await env.call("before_agent_start", event), undefined);
    assert.deepEqual(event.systemPromptOptions.sections, {});
    assert.equal(await env.call("context", { type: "context", messages: transcript() }), undefined);
  });
  it("S3 a throwing config loader fails open", async () => {
    const env = await setup({}, { loadConfig: async () => { throw new Error("bad json"); } });
    await assert.doesNotReject(env.call("session_start", { type: "session_start", reason: "startup" }));
    assert.equal(await env.call("context", { type: "context", messages: transcript() }), undefined);
  });
  it("S4 per-session caches are reset", async () => {
    const env = await setup();
    const seg = { id: "seg", kind: "volatile", text: "x", priority: 0, metadata: { path: "/a.ts" } } as never;
    env.runtime.memo.recordDisclosedReadPaths(["/a.ts"], [seg], new Set(["seg"]));
    assert.deepEqual(env.runtime.memo.disclosedReadPaths, ["/a.ts"], "precondition");
    env.runtime.pendingUserPrefix = "stale";
    await env.call("session_start", { type: "session_start", reason: "resume" });
    assert.equal(env.runtime.memo.disclosedReadPaths, undefined);
    assert.equal(env.runtime.pendingUserPrefix, undefined);
  });
  it("S5 a missing session id falls back to a stable id", async () => {
    const env = await setup();
    await env.call("session_start", { type: "session_start", reason: "startup" }, ctx(""));
    assert.equal(env.runtime.sessionId, "pi-unknown-session");
  });
});

describe("before_agent_start", () => {
  async function started(raw: Record<string, unknown> = {}) {
    const env = await setup(raw);
    await env.call("session_start", { type: "session_start", reason: "startup" });
    return env;
  }
  it("B1 before session_start the hook is a no-op", async () => {
    const env = await setup();
    const event = promptEvent({ appendSystemPrompt: VOLATILE });
    assert.equal(await env.call("before_agent_start", event), undefined);
    assert.equal(event.systemPromptOptions.appendSystemPrompt, VOLATILE);
    assert.deepEqual(event.systemPromptOptions.sections, {});
  });
  it("B2 without volatile lines only the recovery section is added", async () => {
    const env = await started();
    const event = promptEvent({ appendSystemPrompt: "Stable rules." });
    await env.call("before_agent_start", event);
    assert.deepEqual(Object.keys(event.systemPromptOptions.sections), [PI_RECOVERY_SECTION]);
    assert.ok(event.systemPromptOptions.sections[PI_RECOVERY_SECTION]!.startsWith("[Recovery Protocol]"));
    assert.equal(event.systemPromptOptions.appendSystemPrompt, "Stable rules.");
  });
  it("B3 developer target moves volatile lines from every input into the dynamic section", async () => {
    const env = await started();
    const event = promptEvent({
      appendSystemPrompt: VOLATILE,
      sections: { team: "Team notes.\nRequest ID: abc-123" },
      contextFiles: [{ path: "AGENTS.md", content: "Agent rules.\nCurrent date: 2026-09-28" }],
    });
    await env.call("before_agent_start", event);
    const options = event.systemPromptOptions;
    assert.equal(options.appendSystemPrompt, rewriteTextForStablePrefix(VOLATILE).forwardedText);
    assert.equal(options.sections.team, rewriteTextForStablePrefix("Team notes.\nRequest ID: abc-123").forwardedText);
    assert.equal(options.contextFiles[0]?.content, rewriteTextForStablePrefix("Agent rules.\nCurrent date: 2026-09-28").forwardedText);
    assert.equal(options.sections[PI_DYNAMIC_SECTION], "Current date: 2026-09-28\nRequest ID: abc-123");
    assert.equal(env.runtime.pendingUserPrefix, undefined);
  });
  it("B4 user target queues the lines for the first user message instead", async () => {
    const env = await started({ hooks: { dynamicContextTarget: "user" } });
    const event = promptEvent({ appendSystemPrompt: VOLATILE });
    await env.call("before_agent_start", event);
    assert.equal(event.systemPromptOptions.sections[PI_DYNAMIC_SECTION], undefined);
    assert.equal(env.runtime.pendingUserPrefix, "Current date: 2026-09-28");
  });
  it("B5 stabilizer off leaves volatile lines but still adds recovery", async () => {
    const env = await started({ modules: { stabilizer: false } });
    const event = promptEvent({ appendSystemPrompt: VOLATILE });
    await env.call("before_agent_start", event);
    assert.equal(event.systemPromptOptions.appendSystemPrompt, VOLATILE);
    assert.deepEqual(Object.keys(event.systemPromptOptions.sections), [PI_RECOVERY_SECTION]);
  });
  it("B6 the disable env var removes the recovery section", async () => {
    const env = await started();
    process.env.TOKENPILOT_DISABLE_RECOVERY_PROTOCOL = "true";
    try {
      const event = promptEvent();
      await env.call("before_agent_start", event);
      assert.deepEqual(event.systemPromptOptions.sections, {});
    } finally {
      delete process.env.TOKENPILOT_DISABLE_RECOVERY_PROTOCOL;
    }
  });
  it("B7 the hook never forces a full system prompt", async () => {
    const env = await started();
    assert.equal(await env.call("before_agent_start", promptEvent({ appendSystemPrompt: VOLATILE })), undefined);
  });
  it("B8 duplicate volatile lines are collected once", async () => {
    const env = await started();
    const event = promptEvent({ appendSystemPrompt: VOLATILE, sections: { copy: VOLATILE } });
    await env.call("before_agent_start", event);
    assert.equal(event.systemPromptOptions.sections[PI_DYNAMIC_SECTION], "Current date: 2026-09-28");
  });
  it("B9 malformed options fail open", async () => {
    const env = await started();
    const event = { type: "before_agent_start", prompt: "x", systemPrompt: "", systemPromptOptions: null } as unknown as PiEventMap["before_agent_start"];
    assert.equal(await env.call("before_agent_start", event), undefined);
    assert.match(await readFile(adapterLogPath(env.dir), "utf8"), /before_agent_start failed open/);
  });
});

describe("context", () => {
  async function started(raw: Record<string, unknown> = {}) {
    const env = await setup(raw);
    await env.call("session_start", { type: "session_start", reason: "startup" });
    return env;
  }
  it("C1 disabled returns undefined", async () => {
    const env = await started({ enabled: false });
    assert.equal(await env.call("context", { type: "context", messages: transcript() }), undefined);
  });
  it("C2 nothing to reduce returns undefined", async () => {
    const env = await started();
    assert.equal(await env.call("context", { type: "context", messages: transcript("small output") }), undefined);
  });
  it("C3 a large tool output is reduced exactly as the shared pipeline would", async () => {
    const env = await started();
    const original = transcript();
    const out = await env.call("context", { type: "context", messages: original }) as { messages: PiAgentMessage[] };
    assert.equal(out.messages[0], original[0]);
    assert.equal(out.messages[1], original[1]);
    assert.notEqual(out.messages[2], original[2]);
    const text = ((out.messages[2] as { content: Array<{ text: string }> }).content[0]!).text;
    const direct = await reduceCanonicalEnvelope({
      envelope: createCanonicalEnvelope({ hostId: "pi", displayName: "pi", sessionId: SESSION, model: "qwen3", messages: decodePiMessages(original) }),
      config: env.config,
    });
    const directText = ((direct.envelope.messages[2]!.content as Array<{ text: string }>)[0]!).text;
    assert.equal(stripArchive(text), stripArchive(directText));
    const bindings = await loadRecentTurnBindings<{ reductionSavedChars: number; reductionPassSavedChars: Record<string, number> }>(env.dir, SESSION);
    assert.equal(bindings.at(-1)?.reductionSavedChars, BIG.length - text.length);
    assert.ok((bindings.at(-1)?.reductionPassSavedChars.tool_payload_trim ?? 0) > 0);
  });
  it("C4 a repeated request is byte-identical", async () => {
    const env = await started();
    const first = await env.call("context", { type: "context", messages: transcript() });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await env.call("context", { type: "context", messages: transcript() });
    assert.equal(JSON.stringify(second), JSON.stringify(first));
  });
  it("C5 user target prefixes the first real user message request-locally", async () => {
    const env = await started({ hooks: { dynamicContextTarget: "user" } });
    await env.call("before_agent_start", promptEvent({ appendSystemPrompt: VOLATILE }));
    const original: PiAgentMessage[] = [
      { role: "custom", customType: "note", content: "n", display: true, timestamp: 0 },
      ...transcript("small"),
    ];
    const snapshot = JSON.stringify(original);
    const out = await env.call("context", { type: "context", messages: original }) as { messages: PiAgentMessage[] };
    assert.equal(out.messages[0], original[0]);
    assert.equal((out.messages[1] as { content: string }).content, "Current date: 2026-09-28\n\nfix the build");
    assert.equal(JSON.stringify(original), snapshot);
  });
  it("C6 reduction off with a pending prefix only applies the prefix", async () => {
    const env = await started({ hooks: { dynamicContextTarget: "user" }, modules: { reduction: false } });
    await env.call("before_agent_start", promptEvent({ appendSystemPrompt: VOLATILE }));
    const original = transcript();
    const out = await env.call("context", { type: "context", messages: original }) as { messages: PiAgentMessage[] };
    assert.equal(out.messages[2], original[2]);
    assert.ok(String((out.messages[0] as { content: string }).content).startsWith("Current date"));
  });
  it("C7 malformed messages never throw", async () => {
    const env = await started();
    assert.equal(await env.call("context", { type: "context", messages: null as unknown as PiAgentMessage[] }), undefined);
    assert.equal(await env.call("context", { type: "context", messages: [null, 3, "x"] as unknown as PiAgentMessage[] }), undefined);
  });
  it("C8 a trimmed file read stays byte-identical on the next request", async () => {
    const env = await started();
    const code = Array.from({ length: 400 }, (_, i) => `export function handler${i}(input: string): string {\n  return input.trim() + "${i}";\n}\n`).join("\n");
    const base: PiAgentMessage[] = [
      { role: "user", content: "read the handlers", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "call_r", name: "read", arguments: { path: "src/handlers.ts" } }], timestamp: 2 },
      { role: "toolResult", toolCallId: "call_r", toolName: "read", content: [{ type: "text", text: code }], isError: false, timestamp: 3 },
    ];
    const readText = (out: unknown) => JSON.stringify((out as { messages: PiAgentMessage[] }).messages[2]);
    const first = await env.call("context", { type: "context", messages: base });
    assert.ok(readText(first).length < JSON.stringify(base[2]).length, "precondition: the read is trimmed");
    const next: PiAgentMessage[] = [
      ...base,
      { role: "assistant", content: [{ type: "toolCall", id: "call_w", name: "write", arguments: { path: "out.txt", content: "x" } }], timestamp: 4 },
      { role: "toolResult", toolCallId: "call_w", toolName: "write", content: [{ type: "text", text: "wrote 1 byte" }], isError: false, timestamp: 5 },
    ];
    const second = await env.call("context", { type: "context", messages: next });
    assert.equal(readText(second), readText(first));
  });
  it("C9 a restarted pi process sends byte-identical history", async () => {
    const shared = await stateDir();
    const before = await started({ stateDir: shared });
    const first = await before.call("context", { type: "context", messages: transcript() });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const after = await started({ stateDir: shared });
    const second = await after.call("context", { type: "context", messages: transcript() });
    assert.ok(first, "precondition: the first request is reduced");
    assert.equal(JSON.stringify(second), JSON.stringify(first));
  });
  it("C10 a memo save failure still returns the reduced history", async () => {
    const env = await started();
    await mkdir(join(env.config.stateDir, "tokenpilot"), { recursive: true });
    await writeFile(join(env.config.stateDir, "tokenpilot", "reduction-memo"), "not a directory");
    // A trimmed file read records a disclosure, so the memo has something to save.
    const code = Array.from({ length: 400 }, (_, i) => `export function handler${i}(input: string): string {\n  return input.trim() + "${i}";\n}\n`).join("\n");
    const reads: PiAgentMessage[] = [
      { role: "user", content: "read the handlers", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "call_r", name: "read", arguments: { path: "src/handlers.ts" } }], timestamp: 2 },
      { role: "toolResult", toolCallId: "call_r", toolName: "read", content: [{ type: "text", text: code }], isError: false, timestamp: 3 },
    ];
    const out = await env.call("context", { type: "context", messages: reads }) as { messages: PiAgentMessage[] } | undefined;
    assert.ok(out && JSON.stringify(out.messages[2]).length < JSON.stringify(reads[2]).length);
    assert.match(await readFile(adapterLogPath(env.config.stateDir), "utf8"), /reduction memo save failed/);
  });
});

describe("turn_end eviction", () => {
  const TASK: SemanticTaskUpdate = {
    taskId: "task-build",
    objective: "fix the build",
    lifecycle: "completed",
    coveredTurnAbsIds: [`${SESSION}:t1`],
    completionEvidence: ["build passed"],
  };
  const EVICTION_ON = {
    modules: { eviction: true },
    eviction: { enabled: true, minBlockChars: 256 },
    taskStateEstimator: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" },
  };
  function memoryStore() {
    let current: SessionTaskRegistry = createEmptySessionTaskRegistry(SESSION);
    return { load: () => current, persist: (registry: SessionTaskRegistry) => { current = registry; } };
  }
  function projection(): PiProjectedSessionEntry[] {
    const entry = (id: string, message: PiAgentMessage): PiProjectedSessionEntry => ({
      sourceEntry: { type: "message", id, parentId: null, timestamp: "t" },
      messages: [message],
    });
    return [
      entry("e1", { role: "user", content: "fix the build", timestamp: 1 }),
      entry("e2", { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }], timestamp: 2 }),
      entry("e3", { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: BIG }], isError: false, timestamp: 3 }),
      entry("e4", { role: "user", content: "now the docs", timestamp: 4 }),
      entry("e5", { role: "toolResult", toolCallId: "call_2", toolName: "bash", content: [{ type: "text", text: BIG }], isError: false, timestamp: 5 }),
    ];
  }
  const turnEnd = (entries = projection()): PiEventMap["turn_end"] => ({
    type: "turn_end", turnIndex: 1, entries: [], continue: false, context: { contextEntries: entries },
  });
  const estimator = (): TaskStateEstimator => ({ estimate: () => ({ baseVersion: 0, taskUpdates: [TASK] }) });

  it("T1 default config never creates an estimator", async () => {
    let created = false;
    const env = await setup({}, { createEstimator: () => { created = true; return estimator(); } });
    await env.call("session_start", { type: "session_start", reason: "startup" });
    assert.equal(await env.call("turn_end", turnEnd()), undefined);
    assert.equal(created, false);
  });
  it("T2 a completed earlier turn yields context_edit drafts for the evicted entries", async () => {
    const env = await setup(EVICTION_ON, { createEstimator: estimator, registryStore: memoryStore() });
    await env.call("session_start", { type: "session_start", reason: "startup" });
    const out = await env.call("turn_end", turnEnd()) as { entries: Array<{ type: string; targetId: string; replacement: { content: unknown } }> };
    assert.deepEqual(out.entries.map((entry) => [entry.type, entry.targetId]), [["context_edit", "e3"]]);
    const content = out.entries[0]!.replacement.content as Array<{ type: string; text: string }>;
    assert.equal(content[0]?.type, "text");
    assert.ok(content[0]?.text.startsWith("[evicted: tool_result e3]"));
  });
  it("T3 an unavailable estimator is a no-op", async () => {
    const env = await setup(EVICTION_ON, { createEstimator: () => undefined });
    await env.call("session_start", { type: "session_start", reason: "startup" });
    assert.equal(await env.call("turn_end", turnEnd()), undefined);
  });
  it("T4 an empty projection is a no-op", async () => {
    const env = await setup(EVICTION_ON, { createEstimator: estimator, registryStore: memoryStore() });
    await env.call("session_start", { type: "session_start", reason: "startup" });
    assert.equal(await env.call("turn_end", turnEnd([])), undefined);
  });
  it("T5 a throwing estimator fails open and is logged", async () => {
    const env = await setup(EVICTION_ON, {
      createEstimator: () => ({ estimate: () => { throw new Error("estimator down"); } }),
      registryStore: memoryStore(),
    });
    await env.call("session_start", { type: "session_start", reason: "startup" });
    assert.equal(await env.call("turn_end", turnEnd()), undefined);
    assert.match(await readFile(adapterLogPath(env.dir), "utf8"), /turn_end failed open Error: estimator down/);
  });
  it("T6 a host binding without eviction never evicts", async () => {
    const env = await setup(EVICTION_ON, { createEstimator: estimator, registryStore: memoryStore(), supportsEviction: false });
    await env.call("session_start", { type: "session_start", reason: "startup" });
    assert.equal(await env.call("turn_end", turnEnd()), undefined);
  });
});

describe("memory_fault_recover tool", () => {
  it("R1 matches the shared MCP tool definition", async () => {
    const { pi } = await setup();
    const listed = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const mcpTool = (listed?.result?.tools as Array<Record<string, unknown>>)[0]!;
    assert.equal(pi.tools[0]!.name, mcpTool.name);
    assert.equal(pi.tools[0]!.description, mcpTool.description);
    assert.deepEqual(pi.tools[0]!.parameters, mcpTool.inputSchema);
  });
  it("R2 recovers archived content for a known dataKey", async () => {
    const env = await setup();
    await env.call("session_start", { type: "session_start", reason: "startup" });
    const reduced = await env.call("context", { type: "context", messages: transcript() }) as { messages: PiAgentMessage[] };
    const text = ((reduced.messages[2] as { content: Array<{ text: string }> }).content[0]!).text;
    const dataKey = /"dataKey":"([^"]+)"/.exec(text)![1]!;
    const result = await env.pi.tools[0]!.execute("t1", { dataKey }, undefined, undefined, ctx());
    assert.ok(result.content[0]!.text.includes("line 2999 output from build step ok"));
    assert.equal((result.details as Record<string, unknown>).dataKey, dataKey);
  });
  it("R3 an unknown dataKey reports not found without throwing", async () => {
    const env = await setup();
    await env.call("session_start", { type: "session_start", reason: "startup" });
    const result = await env.pi.tools[0]!.execute("t1", { dataKey: "nope" }, undefined, undefined, ctx());
    assert.match(result.content[0]!.text, /No archived content found for dataKey: nope/);
    assert.equal((result.details as Record<string, unknown>).error, "archive_not_found");
  });
  it("R4 a missing dataKey is reported", async () => {
    const env = await setup();
    await env.call("session_start", { type: "session_start", reason: "startup" });
    const result = await env.pi.tools[0]!.execute("t1", {}, undefined, undefined, ctx());
    assert.equal(result.content[0]!.text, "Missing required parameter: dataKey");
  });
});
