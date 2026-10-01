/**
 * Regression matrix: adapters/shared/canonical/reduction.ts
 *
 * ReductionMemo disclosed read paths (carried across requests)
 *   M1 carriedDisclosedReadPaths: nothing recorded → undefined
 *   M2 owner segment still present → not carried
 *   M3 owner segment absent → carried
 *   M4 unattributable path (no eligible segment has that path) → always carried
 *   M5 recordDisclosedReadPaths ignores non-arrays, non-strings and blanks; normalizes
 *      (trim + lowercase); a known path keeps its owner
 *   M6 only a segment in eligibleOwnerIds (a read trimmed this request) can own a path
 *   M7 paths missing from the reported set are dropped
 *   M8 dirty is set only when the recorded set or an owner changes
 *   M9 clear() forgets everything
 * buildCanonicalReductionTurnContext
 *   B1 only `tool_result` blocks become segments (text/tool_call/string content ignored)
 *   B2 segment id is `tool-<callId>`; positional `message-i-block-j` without a call id
 *   B3 tool name from the result block, else from the matching tool_call
 *   B4 path hint from tool_call arguments (path | file_path | filePath | filename)
 *   B5 pass-through messages are never segments
 *   B6 empty result text is not a segment but counts as a tool-like message
 *   B7 latestUserQuery is the last user message's text
 *   B8 disclosedReadPaths are forwarded into turn metadata
 * canonicalEnabledPassIds / canonicalPassOptions
 *   P1 each pass flag maps to exactly its pass id; all off → empty
 *   P2 maxToolChars feeds tool_payload_trim; passOptions override per pass
 * reduceCanonicalEnvelope (partitioned by skip reason / effect)
 *   R1 modules.reduction off         → unchanged, "disabled"
 *   R2 no tool results               → unchanged, "no_candidate_segments"
 *   R3 candidates < triggerMinChars  → unchanged, "below_trigger_min_chars"
 *   R4 passes disabled               → unchanged, "pipeline_no_effect"
 *   R5 reduction applied             → only tool_result text changes; input not mutated;
 *                                       summary counts match the text delta
 *   R6 equivalence: output text == shared runReductionBeforeCall on the same inputs
 *   R7 memo on  → a second run is byte-identical (cache-stable)
 *   R8 memo off → a second run is byte-identical too (archive paths are content-derived)
 *   R9 trimmed content is recoverable through the shared resolveMemoryFaultRecover
 *   R10 non-text blocks (images, tool_call) and message metadata are preserved
 * reduceCanonicalEnvelope across requests with a memo (progressive disclosure)
 *   D1 a trimmed read still in history stays trimmed and byte-identical on the next
 *      request (regression: a live smoke run sent it untrimmed → prefix-cache miss)
 *   D2 once the disclosing read has left history, a fresh read of the same path is a
 *      repeat read and is left untrimmed (shared semantics preserved)
 *   D3 two reads of one path in the same history: first trimmed, second untrimmed,
 *      identical across repeated requests
 *   D4 when two reads share a path, ownership follows the read actually trimmed;
 *      dropping an earlier untrimmed read does not make the retained read expand
 *   D5 a write to the same path earlier in history cannot own the disclosure
 * passSavedChars(summary)
 *   PS1 undefined summary → {}
 *   PS2 only passes that changed text with savedChars > 0 are listed
 *   PS3 repeated pass ids are summed
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureStatePathResolver } from "@lightrsi/artifact-store";
import { createStaticStatePathResolver, type HostRequestEnvelope } from "@lightrsi/host-adapter";
import type { RuntimeMessage } from "@lightrsi/kernel";
import { resolveMemoryFaultRecover } from "@lightrsi/mcp";
import { runReductionBeforeCall } from "@lightrsi/reduction";

import { createCanonicalEnvelope } from "../../shared/canonical/before-call.js";
import { normalizeCanonicalAdapterConfig, type CanonicalAdapterConfig } from "../../shared/canonical/config.js";
import {
  ReductionMemo,
  buildCanonicalReductionTurnContext,
  passSavedChars,
  canonicalEnabledPassIds,
  canonicalPassOptions,
  prepareCanonicalReductionInputs,
  reduceCanonicalEnvelope,
} from "../../shared/canonical/reduction.js";

let stateDir = "";
before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "tp-red-"));
  configureStatePathResolver(createStaticStatePathResolver({ hostId: "opencode", displayName: "OpenCode", stateDir, namespaceDir: "tokenpilot" }));
});

const config = (raw: unknown = {}): CanonicalAdapterConfig => normalizeCanonicalAdapterConfig(raw, { defaultStateDir: stateDir });
const BIG = Array.from({ length: 3000 }, (_, i) => `line ${i} output from build step ok`).join("\n");

function envelope(messages: RuntimeMessage[], sessionId = "s1"): HostRequestEnvelope {
  return createCanonicalEnvelope({ hostId: "opencode", displayName: "OpenCode", sessionId, model: "m", messages });
}

function toolTurn(callId: string, text: string, toolName = "bash", args: Record<string, unknown> = { command: "make" }): RuntimeMessage[] {
  return [
    { role: "assistant", content: [{ type: "tool_call", toolCallId: callId, toolName, argumentsJson: args }] },
    { role: "tool", content: [{ type: "tool_result", toolCallId: callId, toolName, status: "success", text }] },
  ];
}

function resultText(env: HostRequestEnvelope, index: number): string {
  const content = env.messages[index]?.content;
  assert.ok(Array.isArray(content));
  const block = content[0];
  assert.ok(block && block.type === "tool_result");
  return block.text;
}

describe("buildCanonicalReductionTurnContext", () => {
  it("B1 only tool_result blocks become segments", () => {
    const built = buildCanonicalReductionTurnContext(envelope([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "sure" }] },
      ...toolTurn("c1", "out"),
      { role: "tool", content: "raw string content" },
    ]));
    assert.deepEqual(built.turnCtx.segments.map((s) => s.id), ["tool-c1"]);
  });
  it("B2 segment ids use the call id, else the position", () => {
    const built = buildCanonicalReductionTurnContext(envelope([
      { role: "tool", content: [{ type: "tool_result", status: "success", text: "anon" }] },
      ...toolTurn("c9", "named"),
    ]));
    assert.deepEqual(built.turnCtx.segments.map((s) => s.id), ["message-0-block-0", "tool-c9"]);
  });
  it("B3 tool name comes from the result block, else the matching call", () => {
    const built = buildCanonicalReductionTurnContext(envelope([
      { role: "assistant", content: [{ type: "tool_call", toolCallId: "c1", toolName: "grep" }] },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "c1", status: "success", text: "x" }] },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "c1", toolName: "own", status: "success", text: "y" }] },
    ]));
    assert.deepEqual(built.bindings.map((b) => b.toolName), ["grep", "own"]);
  });
  it("B4 path hints come from path, file_path, filePath or filename", () => {
    for (const key of ["path", "file_path", "filePath", "filename"]) {
      const built = buildCanonicalReductionTurnContext(envelope(toolTurn("c1", "x", "read", { [key]: " /src/a.ts " })));
      assert.equal(built.turnCtx.segments[0]?.metadata?.path, "/src/a.ts", key);
    }
  });
  it("B5 pass-through messages are never segments", () => {
    const built = buildCanonicalReductionTurnContext(envelope([
      { role: "tool", content: [{ type: "tool_result", toolCallId: "c1", status: "success", text: "x" }], metadata: { lightrsiPassThrough: true } },
    ]));
    assert.equal(built.turnCtx.segments.length, 0);
  });
  it("B6 empty result text is skipped but counted as tool-like", () => {
    const built = buildCanonicalReductionTurnContext(envelope(toolTurn("c1", "")));
    assert.equal(built.turnCtx.segments.length, 0);
    assert.equal(built.diagnostics.toolLikeMessages, 1);
  });
  it("B7 latestUserQuery is the last user text", () => {
    const built = buildCanonicalReductionTurnContext(envelope([
      { role: "user", content: "first" },
      { role: "user", content: [{ type: "text", text: "second" }] },
      ...toolTurn("c1", "x"),
    ]));
    assert.equal(built.turnCtx.metadata?.latestUserQuery, "second");
  });
  it("B8 disclosed read paths are forwarded", () => {
    const built = buildCanonicalReductionTurnContext(envelope(toolTurn("c1", "x")), { disclosedReadPaths: ["/a"] });
    assert.deepEqual(built.turnCtx.metadata?.disclosedReadPaths, ["/a"]);
  });
});

describe("pass selection", () => {
  const names = {
    readStateCompaction: "read_state_compaction",
    toolPayloadTrim: "tool_payload_trim",
    htmlSlimming: "html_slimming",
    execOutputTruncation: "exec_output_truncation",
    agentsStartupOptimization: "agents_startup_optimization",
  } as const;
  const allOff = Object.fromEntries(Object.keys(names).map((key) => [key, false]));
  it("P1 each pass flag maps to exactly its pass id", () => {
    assert.deepEqual([...canonicalEnabledPassIds(config({ reduction: { passes: allOff } }))], []);
    for (const [flag, id] of Object.entries(names)) {
      const cfg = config({ reduction: { passes: { ...allOff, [flag]: true } } });
      assert.deepEqual([...canonicalEnabledPassIds(cfg)], [id], flag);
    }
  });
  it("P2 maxToolChars feeds tool_payload_trim and passOptions override it", () => {
    assert.equal(canonicalPassOptions(config({ reduction: { maxToolChars: 1800 } })).tool_payload_trim?.maxChars, 1800);
    const cfg = config({ reduction: { maxToolChars: 1800, passOptions: { toolPayloadTrim: { maxChars: 999 } } } });
    assert.equal(canonicalPassOptions(cfg).tool_payload_trim?.maxChars, 999);
  });
});

describe("reduceCanonicalEnvelope", () => {
  it("R1 reduction module off leaves the envelope untouched", async () => {
    const env = envelope(toolTurn("c1", BIG));
    const out = await reduceCanonicalEnvelope({ envelope: env, config: config({ modules: { reduction: false } }) });
    assert.equal(out.envelope, env);
    assert.equal(out.summary.skippedReason, "disabled");
  });
  it("R2 no tool results", async () => {
    const env = envelope([{ role: "user", content: BIG }]);
    const out = await reduceCanonicalEnvelope({ envelope: env, config: config() });
    assert.equal(out.envelope, env);
    assert.equal(out.summary.skippedReason, "no_candidate_segments");
  });
  it("R3 candidates below triggerMinChars", async () => {
    const env = envelope(toolTurn("c1", "x".repeat(500)));
    const out = await reduceCanonicalEnvelope({ envelope: env, config: config() });
    assert.equal(out.envelope, env);
    assert.equal(out.summary.skippedReason, "below_trigger_min_chars");
  });
  it("R4 all passes disabled has no effect", async () => {
    const env = envelope(toolTurn("c1", BIG));
    const passes = { readStateCompaction: false, toolPayloadTrim: false, htmlSlimming: false, execOutputTruncation: false, agentsStartupOptimization: false };
    const out = await reduceCanonicalEnvelope({ envelope: env, config: config({ reduction: { passes } }) });
    assert.equal(out.envelope, env);
    assert.equal(out.summary.skippedReason, "pipeline_no_effect");
  });
  it("R5 an applied reduction changes only tool_result text and never mutates the input", async () => {
    const env = envelope([{ role: "user", content: "build" }, ...toolTurn("c1", BIG)]);
    const snapshot = JSON.stringify(env);
    const out = await reduceCanonicalEnvelope({ envelope: env, config: config() });
    assert.equal(JSON.stringify(env), snapshot, "input mutated");
    assert.notEqual(out.envelope, env);
    assert.deepEqual(out.envelope.messages.slice(0, 2), env.messages.slice(0, 2));
    const after = resultText(out.envelope, 2);
    assert.ok(after.length < BIG.length);
    assert.equal(out.summary.changedBlocks, 1);
    assert.equal(out.summary.savedChars, BIG.length - after.length);
    assert.equal(out.summary.beforeChars - out.summary.afterChars, out.summary.savedChars);
    assert.equal(out.summary.visualSegments?.[0]?.segmentId, "tool-c1");
  });
  it("R6 output text equals the shared pipeline run directly on the same inputs", async () => {
    const env = envelope([{ role: "user", content: "build" }, ...toolTurn("c1", BIG), ...toolTurn("c2", JSON.stringify({ rows: Array.from({ length: 300 }, (_, i) => ({ i })) }), "read", { path: "/a.json" })]);
    const cfg = config();
    const out = await reduceCanonicalEnvelope({ envelope: env, config: cfg });
    const inputs = prepareCanonicalReductionInputs(env, cfg);
    const direct = await runReductionBeforeCall({ turnCtx: inputs.turnCtx, passes: inputs.passes });
    const directById = new Map(direct.turnCtx.segments.map((s) => [s.id, s.text]));
    assert.equal(resultText(out.envelope, 2), directById.get("tool-c1"));
    assert.equal(resultText(out.envelope, 4), directById.get("tool-c2"));
  });
  it("R7 with the memo a second run is byte-identical", async () => {
    const env = envelope([{ role: "user", content: "build" }, ...toolTurn("c1", BIG)], "s-memo");
    const memo = new ReductionMemo();
    const first = await reduceCanonicalEnvelope({ envelope: env, config: config(), memo });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await reduceCanonicalEnvelope({ envelope: env, config: config(), memo });
    assert.equal(JSON.stringify(second.envelope.messages), JSON.stringify(first.envelope.messages));
  });
  it("R8 without the memo a rerun is byte-identical too", async () => {
    const env = envelope([{ role: "user", content: "build" }, ...toolTurn("c1", BIG)], "s-nomemo");
    const first = await reduceCanonicalEnvelope({ envelope: env, config: config() });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await reduceCanonicalEnvelope({ envelope: env, config: config() });
    assert.equal(resultText(second.envelope, 2), resultText(first.envelope, 2));
  });
  it("R9 trimmed content is recoverable through the shared recovery tool", async () => {
    const env = envelope([{ role: "user", content: "build" }, ...toolTurn("c1", BIG)], "s-recover");
    const out = await reduceCanonicalEnvelope({ envelope: env, config: config() });
    const dataKey = /"dataKey":"([^"]+)"/.exec(resultText(out.envelope, 2))?.[1];
    assert.equal(dataKey, "segment:tool-c1");
    const recovered = await resolveMemoryFaultRecover({ dataKey: dataKey!, stateDir });
    assert.ok(recovered.text.includes("line 2999 output from build step ok"));
    assert.equal(recovered.details.error, undefined);
  });
  it("R10 non-text blocks and metadata are preserved", async () => {
    const env = envelope([
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mediaType: "image/png" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_call", toolCallId: "c1", toolName: "bash" }], metadata: { reasoning: ["think"] } },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "c1", toolName: "bash", status: "error", text: BIG }], metadata: { piIndex: 2 } },
    ]);
    const out = await reduceCanonicalEnvelope({ envelope: env, config: config() });
    assert.deepEqual(out.envelope.messages[0], env.messages[0]);
    assert.deepEqual(out.envelope.messages[1], env.messages[1]);
    assert.deepEqual(out.envelope.messages[2]?.metadata, { piIndex: 2 });
    const block = (out.envelope.messages[2]?.content as Array<Record<string, unknown>>)[0];
    assert.equal(block?.status, "error");
    assert.equal(block?.toolCallId, "c1");
  });
});

describe("passSavedChars", () => {
  const effect = (id: string, changed: boolean, savedChars: number) => ({ id, changed, beforeChars: 100, afterChars: 100 - savedChars, savedChars });
  const summary = (passEffects: ReturnType<typeof effect>[]) => ({
    changedMessages: 0, changedBlocks: 0, savedChars: 0, beforeChars: 0, afterChars: 0, report: [], passEffects,
    diagnostics: { messageCount: 0, toolLikeMessages: 0, candidateSegments: 0, candidateChars: 0 },
  });
  it("PS1 an undefined summary yields an empty record", () => {
    assert.deepEqual(passSavedChars(undefined), {});
  });
  it("PS2 only changed passes with savings are listed", () => {
    assert.deepEqual(passSavedChars(summary([effect("tool_payload_trim", true, 40), effect("html_slimming", false, 0), effect("read_state_compaction", true, 0)])), { tool_payload_trim: 40 });
  });
  it("PS3 repeated pass ids are summed", () => {
    assert.deepEqual(passSavedChars(summary([effect("a", true, 10), effect("a", true, 5)])), { a: 15 });
  });
});

describe("ReductionMemo disclosed read paths", () => {
  const seg = (id: string, path?: string) => ({ id, kind: "volatile", text: "x", priority: 0, metadata: path ? { path } : {} }) as never;
  const all = (...ids: string[]) => new Set(ids);
  it("M1 nothing recorded carries nothing", () => {
    assert.equal(new ReductionMemo().carriedDisclosedReadPaths(new Set()), undefined);
  });
  it("M2 a path whose owner is still present is not carried", () => {
    const memo = new ReductionMemo();
    memo.recordDisclosedReadPaths(["/repo/a.ts"], [seg("tool-1", "/repo/a.ts")], all("tool-1"));
    assert.equal(memo.carriedDisclosedReadPaths(new Set(["tool-1"])), undefined);
  });
  it("M3 a path whose owner has left the history is carried", () => {
    const memo = new ReductionMemo();
    memo.recordDisclosedReadPaths(["/repo/a.ts"], [seg("tool-1", "/repo/a.ts")], all("tool-1"));
    assert.deepEqual(memo.carriedDisclosedReadPaths(new Set(["tool-2"])), ["/repo/a.ts"]);
  });
  it("M4 an unattributable path is always carried", () => {
    const memo = new ReductionMemo();
    memo.recordDisclosedReadPaths(["/repo/b.ts"], [seg("tool-1", "/repo/a.ts")], all("tool-1"));
    assert.deepEqual(memo.carriedDisclosedReadPaths(new Set(["tool-1"])), ["/repo/b.ts"]);
  });
  it("M5 recording ignores junk, normalizes, and a known path keeps its owner", () => {
    const memo = new ReductionMemo();
    memo.recordDisclosedReadPaths("nope", [seg("tool-1", "/a")], all("tool-1"));
    memo.recordDisclosedReadPaths([42, "", "  "], [seg("tool-1", "/a")], all("tool-1"));
    assert.equal(memo.disclosedReadPaths, undefined);
    memo.recordDisclosedReadPaths(["  /Repo/A.ts "], [seg("tool-1", "/repo/a.ts"), seg("tool-2", "/repo/a.ts")], all("tool-1", "tool-2"));
    memo.recordDisclosedReadPaths(["/repo/a.ts"], [seg("tool-3", "/repo/a.ts")], all("tool-3"));
    assert.deepEqual(memo.disclosedReadPaths, ["/repo/a.ts"]);
    assert.equal(memo.carriedDisclosedReadPaths(new Set(["tool-1"])), undefined);
    assert.deepEqual(memo.carriedDisclosedReadPaths(new Set(["tool-2", "tool-3"])), ["/repo/a.ts"]);
  });
  it("M6 only an eligible segment can own a path", () => {
    const memo = new ReductionMemo();
    memo.recordDisclosedReadPaths(["/repo/a.ts"], [seg("write-1", "/repo/a.ts"), seg("read-1", "/repo/a.ts")], all("read-1"));
    assert.equal(memo.carriedDisclosedReadPaths(new Set(["read-1"])), undefined);
    assert.deepEqual(memo.carriedDisclosedReadPaths(new Set(["write-1"])), ["/repo/a.ts"]);
    const none = new ReductionMemo();
    none.recordDisclosedReadPaths(["/repo/a.ts"], [seg("read-1", "/repo/a.ts")], all());
    assert.deepEqual(none.carriedDisclosedReadPaths(new Set(["read-1"])), ["/repo/a.ts"], "no eligible owner → unattributable");
  });
  it("M7 paths missing from the reported set are dropped", () => {
    const memo = new ReductionMemo();
    memo.recordDisclosedReadPaths(["/a", "/b"], [seg("t1", "/a"), seg("t2", "/b")], all("t1", "t2"));
    memo.recordDisclosedReadPaths(["/b"], [], all());
    assert.deepEqual(memo.disclosedReadPaths, ["/b"]);
    assert.equal(memo.carriedDisclosedReadPaths(new Set(["t2"])), undefined, "/b keeps its owner");
  });
  it("M8 dirty tracks real changes only", () => {
    const memo = new ReductionMemo();
    assert.equal(memo.dirty, false);
    memo.recordDisclosedReadPaths(["/a"], [seg("t1", "/a")], all("t1"));
    assert.equal(memo.dirty, true);
    memo.dirty = false;
    memo.recordDisclosedReadPaths(["/A "], [seg("t9", "/a")], all("t9"));
    assert.equal(memo.dirty, false, "same set, same owner");
    memo.recordDisclosedReadPaths(["/a", "/b"], [], all());
    assert.equal(memo.dirty, true, "path added");
    memo.dirty = false;
    memo.recordDisclosedReadPaths(["/b"], [], all());
    assert.equal(memo.dirty, true, "path dropped");
  });
  it("M9 clear forgets everything", () => {
    const memo = new ReductionMemo();
    memo.recordDisclosedReadPaths(["/a"], [seg("t1", "/a")], all("t1"));
    memo.clear();
    assert.equal(memo.disclosedReadPaths, undefined);
    assert.equal(memo.dirty, false);
  });
});

describe("reduceCanonicalEnvelope across requests (progressive disclosure)", () => {
  const CODE = Array.from({ length: 400 }, (_, i) => `export function handler${i}(input: string): string {\n  const value = input.trim();\n  return value + "${i}";\n}\n`).join("\n");
  const PATH = "/repo/src/handlers.ts";
  const user = (text: string): RuntimeMessage => ({ role: "user", content: [{ type: "text", text }] });
  const read = (callId: string) => toolTurn(callId, CODE, "read", { path: PATH });
  const trimmedAt = (env: HostRequestEnvelope, index: number) => resultText(env, index).length < CODE.length;

  it("D1 a trimmed read still in history stays trimmed and byte-identical on the next request", async () => {
    const memo = new ReductionMemo();
    const first = [user("read the handlers"), ...read("r1")];
    const a = await reduceCanonicalEnvelope({ envelope: envelope(first, "d1"), config: config(), memo });
    assert.ok(trimmedAt(a.envelope, 2), "precondition: the first read is trimmed");
    const next = [...first, ...toolTurn("w1", "wrote 10 bytes", "write", { path: "/repo/out.txt" })];
    const b = await reduceCanonicalEnvelope({ envelope: envelope(next, "d1"), config: config(), memo });
    assert.equal(resultText(b.envelope, 2), resultText(a.envelope, 2));
    const c = await reduceCanonicalEnvelope({ envelope: envelope(next, "d1"), config: config(), memo });
    assert.equal(resultText(c.envelope, 2), resultText(a.envelope, 2));
  });

  it("D2 after the disclosing read leaves history, a fresh read of the same path is left untrimmed", async () => {
    const memo = new ReductionMemo();
    const a = await reduceCanonicalEnvelope({ envelope: envelope([user("read"), ...read("r1")], "d2"), config: config(), memo });
    assert.ok(trimmedAt(a.envelope, 2));
    const compacted = [user("summary of earlier work"), user("read it again in full"), ...read("r2")];
    const b = await reduceCanonicalEnvelope({ envelope: envelope(compacted, "d2"), config: config(), memo });
    assert.equal(resultText(b.envelope, 3), CODE);
  });

  it("D3 two reads of one path in one history: first trimmed, second untrimmed, stable across requests", async () => {
    const memo = new ReductionMemo();
    const history = [user("read"), ...read("r1"), user("again"), ...read("r2")];
    const a = await reduceCanonicalEnvelope({ envelope: envelope(history, "d3"), config: config(), memo });
    assert.ok(trimmedAt(a.envelope, 2));
    assert.equal(resultText(a.envelope, 5), CODE);
    const b = await reduceCanonicalEnvelope({ envelope: envelope(history, "d3"), config: config(), memo });
    assert.equal(resultText(b.envelope, 2), resultText(a.envelope, 2));
    assert.equal(resultText(b.envelope, 5), CODE);
  });

  it("D4 ownership follows the same-path read actually trimmed", async () => {
    const memo = new ReductionMemo();
    const a = await reduceCanonicalEnvelope({
      envelope: envelope([user("read it twice"), ...toolTurn("short", "not found", "read", { path: PATH }), ...read("long")], "d4"),
      config: config(),
      memo,
    });
    assert.ok(trimmedAt(a.envelope, 4), "precondition: only the long read is trimmed");
    assert.equal(resultText(a.envelope, 2), "not found");
    assert.equal(memo.carriedDisclosedReadPaths(new Set(["tool-long"])), undefined, "the trimmed read owns the path");
    const b = await reduceCanonicalEnvelope({ envelope: envelope([user("after compaction"), ...read("long")], "d4"), config: config(), memo });
    assert.ok(trimmedAt(b.envelope, 2), "the retained long read must not expand back to full content");
  });

  it("D5 a write to the same path cannot own the disclosure", async () => {
    const memo = new ReductionMemo();
    const history = [user("write then read"), ...toolTurn("w1", "wrote the file", "write", { path: PATH }), ...read("r1")];
    const a = await reduceCanonicalEnvelope({ envelope: envelope(history, "d5"), config: config(), memo });
    assert.ok(trimmedAt(a.envelope, 4));
    assert.equal(memo.carriedDisclosedReadPaths(new Set(["tool-r1"])), undefined, "the read owns the path");
    assert.deepEqual(memo.carriedDisclosedReadPaths(new Set(["tool-w1"])), [PATH], "the write does not");
  });
});
