/**
 * Regression matrix: adapters/shared/canonical/reduction.ts
 *
 * ReductionMemo.settle(segmentId, original, next)
 *   S1 first sighting                                → returns next, remembers it
 *   S2 same key, next differs ONLY in `Archive:` line → returns remembered text (reused)
 *   S3 same key, next differs elsewhere              → returns next, replaces memory
 *   S4 same key, identical next                      → returns next, not reused
 *   S5 same segment id, different original text      → independent keys
 *   S6 clear() forgets outputs and disclosed read paths
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
 *      (modulo the timestamped Archive line)
 *   R7 memo on  → a second run is byte-identical (cache-stable)
 *   R8 memo off, or stableArchiveHints=false → second run differs only in Archive line
 *   R9 trimmed content is recoverable through the shared resolveMemoryFaultRecover
 *   R10 non-text blocks (images, tool_call) and message metadata are preserved
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
  canonicalEnabledPassIds,
  canonicalPassOptions,
  prepareCanonicalReductionInputs,
  reduceCanonicalEnvelope,
} from "../../shared/canonical/reduction.js";

let stateDir = "";
before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "tp-red-"));
  configureStatePathResolver(createStaticStatePathResolver({ hostId: "pi", displayName: "pi", stateDir, namespaceDir: "tokenpilot" }));
});

const config = (raw: unknown = {}): CanonicalAdapterConfig => normalizeCanonicalAdapterConfig(raw, { defaultStateDir: stateDir });
const BIG = Array.from({ length: 3000 }, (_, i) => `line ${i} output from build step ok`).join("\n");
const stripArchive = (text: string) => text.replace(/\nArchive: [^\n]*$/, "\nArchive: <path>");

function envelope(messages: RuntimeMessage[], sessionId = "s1"): HostRequestEnvelope {
  return createCanonicalEnvelope({ hostId: "pi", displayName: "pi", sessionId, model: "m", messages });
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

describe("ReductionMemo.settle", () => {
  const withArchive = (body: string, path: string) => `${body}\nArchive: ${path}`;
  it("S1 the first sighting returns and remembers next", () => {
    const memo = new ReductionMemo();
    assert.deepEqual(memo.settle("seg", "orig", "a"), { text: "a", reused: false });
    assert.equal(memo.size, 1);
  });
  it("S2 an Archive-only difference returns the remembered text", () => {
    const memo = new ReductionMemo();
    memo.settle("seg", "orig", withArchive("body", "/1.json"));
    assert.deepEqual(memo.settle("seg", "orig", withArchive("body", "/2.json")), { text: withArchive("body", "/1.json"), reused: true });
  });
  it("S3 any other difference returns next and replaces the memory", () => {
    const memo = new ReductionMemo();
    memo.settle("seg", "orig", withArchive("body", "/1.json"));
    assert.deepEqual(memo.settle("seg", "orig", withArchive("other", "/2.json")), { text: withArchive("other", "/2.json"), reused: false });
    assert.deepEqual(memo.settle("seg", "orig", withArchive("other", "/3.json")).text, withArchive("other", "/2.json"));
  });
  it("S4 an identical next is returned and not marked reused", () => {
    const memo = new ReductionMemo();
    memo.settle("seg", "orig", withArchive("body", "/1.json"));
    assert.deepEqual(memo.settle("seg", "orig", withArchive("body", "/1.json")), { text: withArchive("body", "/1.json"), reused: false });
  });
  it("S5 a different original text under the same segment id is independent", () => {
    const memo = new ReductionMemo();
    memo.settle("seg", "orig-a", withArchive("body", "/1.json"));
    assert.deepEqual(memo.settle("seg", "orig-b", withArchive("body", "/2.json")).reused, false);
    assert.equal(memo.size, 2);
  });
  it("S6 clear forgets outputs and disclosed read paths", () => {
    const memo = new ReductionMemo();
    memo.settle("seg", "orig", "a");
    memo.disclosedReadPaths = ["/a"];
    memo.clear();
    assert.equal(memo.size, 0);
    assert.equal(memo.disclosedReadPaths, undefined);
  });
});

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
    assert.equal(stripArchive(resultText(out.envelope, 2)), stripArchive(directById.get("tool-c1") ?? ""));
    assert.equal(stripArchive(resultText(out.envelope, 4)), stripArchive(directById.get("tool-c2") ?? ""));
  });
  it("R7 with the memo a second run is byte-identical", async () => {
    const env = envelope([{ role: "user", content: "build" }, ...toolTurn("c1", BIG)], "s-memo");
    const memo = new ReductionMemo();
    const first = await reduceCanonicalEnvelope({ envelope: env, config: config(), memo });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await reduceCanonicalEnvelope({ envelope: env, config: config(), memo });
    assert.equal(JSON.stringify(second.envelope.messages), JSON.stringify(first.envelope.messages));
    assert.equal(second.summary.memoReusedSegments, 1);
  });
  it("R8 without the memo (or with stableArchiveHints off) a rerun differs only in the Archive line", async () => {
    const env = envelope([{ role: "user", content: "build" }, ...toolTurn("c1", BIG)], "s-nomemo");
    for (const variant of [{ memo: undefined, cfg: config() }, { memo: new ReductionMemo(), cfg: config({ reduction: { stableArchiveHints: false } }) }]) {
      const first = await reduceCanonicalEnvelope({ envelope: env, config: variant.cfg, memo: variant.memo });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await reduceCanonicalEnvelope({ envelope: env, config: variant.cfg, memo: variant.memo });
      assert.notEqual(resultText(second.envelope, 2), resultText(first.envelope, 2));
      assert.equal(stripArchive(resultText(second.envelope, 2)), stripArchive(resultText(first.envelope, 2)));
    }
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
