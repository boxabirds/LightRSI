/**
 * Regression matrix: opencode/src/codec.ts + opencode/src/overlay.ts
 *
 * decodeOpenCodeMessages (mirrors toModelMessagesEffect in OpenCode 1.18.33)
 *   D1 user text parts → text blocks; `ignored` and empty text skipped; image files → image
 *      blocks; text/plain files and other parts not decoded; empty user → no message
 *   D2 assistant text → text blocks (empty text kept); reasoning → metadata.reasoning;
 *      completed/error tool parts → tool_call blocks + one `tool` message per result
 *   D3 completed tool output → success; natively pruned (time.compacted) → placeholder
 *   D4 error tool → error status with error text; interrupted error with output → success
 *      with the partial output
 *   D5 pending/running tools, step/patch/snapshot/agent/retry/compaction parts → not decoded
 *   D6 compaction-summary assistant messages carry metadata.ocSummary
 *   D7 malformed entries (non-object, missing info/parts) are skipped, never thrown
 *   D8 metadata carries message id / index and, for tool results, the part id
 * applyOpenCodeChanges
 *   A1 no canonical change → 0 replacements, same array elements
 *   A2 tool output change → cloned part (state.output) in a cloned message; storage
 *      objects untouched
 *   A3 error tool change → state.error; interrupted error → metadata.output
 *   A4 natively pruned part → never written
 *   A5 user text change → first text part gets the text, other text parts emptied
 *   A6 assistant text change → same rule; tool parts untouched
 *   A7 several changes in one message → one replacement
 * openCodeSurfaceId / openCodeSurfaceEntries
 *   S1 tool results are `part:<id>`, everything else `msg:<id>`
 *   S2 turns increment on user messages
 *   S3 summaries are checkpoints; overlaid ids and pruned outputs are alreadyEvicted
 * overlay store
 *   O1 missing file → empty overlay;  O2 save → load round trip;  O3 corrupt file → empty
 *   O4 applyOverlay: tool results get the stored text; assistant text is replaced while
 *      tool_call blocks are kept; non-overlaid messages keep identity; count reported
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  OC_PRUNED_PLACEHOLDER,
  applyOpenCodeChanges,
  decodeOpenCodeMessages,
  openCodeSurfaceEntries,
  openCodeSurfaceId,
} from "../src/codec.js";
import type { OcMessageWithParts, OcPart, OcToolPart } from "../src/opencode-types.js";
import { applyOverlay, loadOverlay, overlayPath, saveOverlay } from "../src/overlay.js";

const S = "ses_1";
let seq = 0;
const id = (prefix: string) => `${prefix}_${++seq}`;

function userMsg(parts: OcPart[], messageId = id("msg")): OcMessageWithParts {
  return { info: { id: messageId, sessionID: S, role: "user", model: { providerID: "llama", modelID: "qwen3" } }, parts };
}
function assistantMsg(parts: OcPart[], extra: Record<string, unknown> = {}, messageId = id("msg")): OcMessageWithParts {
  return { info: { id: messageId, sessionID: S, role: "assistant", ...extra }, parts };
}
const text = (t: string, extra: Record<string, unknown> = {}): OcPart => ({ id: id("prt"), sessionID: S, messageID: "m", type: "text", text: t, ...extra });
function tool(callID: string, state: OcToolPart["state"], partId = id("prt")): OcToolPart {
  return { id: partId, sessionID: S, messageID: "m", type: "tool", callID, tool: "bash", state };
}
const completed = (output: string, compacted?: number): OcToolPart["state"] => ({
  status: "completed", input: { command: "make" }, output, title: "make", metadata: {}, time: { start: 1, end: 2, ...(compacted ? { compacted } : {}) },
});

describe("decodeOpenCodeMessages", () => {
  it("D1 user parts", () => {
    const decoded = decodeOpenCodeMessages([
      userMsg([text("hello"), text("hidden", { ignored: true }), text(""), { id: "f1", type: "file", mime: "image/png", url: "data:," }, { id: "f2", type: "file", mime: "text/plain", url: "file://x" }]),
      userMsg([text("", {}), { id: "sp", type: "step-start" }]),
    ]);
    assert.equal(decoded.messages.length, 1);
    assert.deepEqual(decoded.messages[0]?.content, [{ type: "text", text: "hello" }, { type: "image", mediaType: "image/png" }]);
    assert.deepEqual(decoded.bindings[0], { kind: "user", messageIndex: 0, textPartIndexes: [0] });
  });
  it("D2 assistant text, reasoning and tool parts", () => {
    const decoded = decodeOpenCodeMessages([assistantMsg([
      { id: "r", type: "reasoning", text: "think" },
      text(""),
      text("Running make."),
      tool("call_1", completed("ok")),
    ])]);
    assert.deepEqual(decoded.messages.map((m) => m.role), ["assistant", "tool"]);
    assert.deepEqual(decoded.messages[0]?.content, [
      { type: "text", text: "" },
      { type: "text", text: "Running make." },
      { type: "tool_call", toolCallId: "call_1", toolName: "bash", argumentsJson: { command: "make" } },
    ]);
    assert.deepEqual(decoded.messages[0]?.metadata?.reasoning, ["think"]);
    assert.deepEqual(decoded.bindings.map((b) => b.kind), ["assistant", "tool"]);
  });
  it("D3 completed output and native pruning", () => {
    const decoded = decodeOpenCodeMessages([assistantMsg([tool("a", completed("out")), tool("b", completed("old", 99))])]);
    const results = decoded.messages.filter((m) => m.role === "tool").map((m) => (m.content as Array<{ text: string; status: string }>)[0]);
    assert.deepEqual(results.map((r) => [r?.text, r?.status]), [["out", "success"], [OC_PRUNED_PLACEHOLDER, "success"]]);
  });
  it("D4 errors and interrupted errors", () => {
    const decoded = decodeOpenCodeMessages([assistantMsg([
      tool("e", { status: "error", input: {}, error: "boom", time: { start: 1, end: 2 } }),
      tool("i", { status: "error", input: {}, error: "interrupted", metadata: { interrupted: true, output: "partial" }, time: { start: 1, end: 2 } }),
    ])]);
    const results = decoded.messages.filter((m) => m.role === "tool").map((m) => (m.content as Array<{ text: string; status: string }>)[0]);
    assert.deepEqual(results.map((r) => [r?.text, r?.status]), [["boom", "error"], ["partial", "success"]]);
  });
  it("D5 pending/running tools and structural parts are not decoded", () => {
    const decoded = decodeOpenCodeMessages([assistantMsg([
      tool("p", { status: "pending", input: {} }),
      tool("r", { status: "running", input: {} }),
      { id: "s", type: "step-start" }, { id: "f", type: "step-finish" }, { id: "pa", type: "patch" }, { id: "sn", type: "snapshot" },
    ])]);
    assert.deepEqual(decoded.messages.map((m) => [m.role, m.content]), [["assistant", []]]);
  });
  it("D6 compaction summaries are flagged", () => {
    const decoded = decodeOpenCodeMessages([assistantMsg([text("summary")], { summary: true })]);
    assert.equal(decoded.messages[0]?.metadata?.ocSummary, true);
  });
  it("D7 malformed entries are skipped", () => {
    const decoded = decodeOpenCodeMessages([null, { info: null }, { info: { role: "user" } }, { parts: [] }] as unknown as OcMessageWithParts[]);
    assert.deepEqual(decoded.messages, []);
  });
  it("D8 metadata identifies the source message and part", () => {
    const part = tool("c", completed("x"), "prt_fixed");
    const decoded = decodeOpenCodeMessages([assistantMsg([part], {}, "msg_fixed")]);
    assert.deepEqual(decoded.messages[1]?.metadata, { ocMessageId: "msg_fixed", ocIndex: 0, ocPartId: "prt_fixed" });
  });
});

describe("applyOpenCodeChanges", () => {
  function fixture() {
    const messages: OcMessageWithParts[] = [
      userMsg([text("fix it"), text("please")]),
      assistantMsg([text("On it."), tool("c1", completed("x".repeat(100))), tool("c2", { status: "error", input: {}, error: "boom", time: { start: 1, end: 2 } }), tool("c3", completed("old", 5)), tool("c4", { status: "error", input: {}, error: "int", metadata: { interrupted: true, output: "partial" }, time: { start: 1, end: 2 } })]),
    ];
    const snapshot = JSON.stringify(messages);
    const originals = [...messages];
    const decoded = decodeOpenCodeMessages(messages);
    const canonical = decoded.messages.map((m) => ({ ...m, content: Array.isArray(m.content) ? m.content.map((b) => ({ ...b })) : m.content }));
    return { messages, snapshot, originals, decoded, canonical };
  }
  const setText = (canonical: ReturnType<typeof fixture>["canonical"], index: number, value: string) => {
    const content = canonical[index]!.content as Array<{ type: string; text: string }>;
    const block = content.find((b) => b.type === "text" || b.type === "tool_result")!;
    block.text = value;
  };
  it("A1 no change leaves every element as is", () => {
    const f = fixture();
    assert.equal(applyOpenCodeChanges(f.messages, f.decoded, f.canonical), 0);
    f.messages.forEach((m, i) => assert.equal(m, f.originals[i]));
  });
  it("A2 a tool output change clones the part and message", () => {
    const f = fixture();
    setText(f.canonical, 2, "trimmed");
    assert.equal(applyOpenCodeChanges(f.messages, f.decoded, f.canonical), 1);
    assert.notEqual(f.messages[1], f.originals[1]);
    assert.equal((f.messages[1]!.parts[1] as OcToolPart).state.status, "completed");
    assert.equal(((f.messages[1]!.parts[1] as OcToolPart).state as { output: string }).output, "trimmed");
    assert.equal(JSON.stringify(f.originals), f.snapshot, "stored objects mutated");
  });
  it("A3 error and interrupted-error changes", () => {
    const f = fixture();
    setText(f.canonical, 3, "boom-short");
    setText(f.canonical, 5, "partial-short");
    applyOpenCodeChanges(f.messages, f.decoded, f.canonical);
    assert.equal(((f.messages[1]!.parts[2] as OcToolPart).state as { error: string }).error, "boom-short");
    const interrupted = (f.messages[1]!.parts[4] as OcToolPart).state as unknown as { error: string; metadata: { output: string } };
    assert.deepEqual([interrupted.error, interrupted.metadata.output], ["int", "partial-short"]);
  });
  it("A4 natively pruned parts are never written", () => {
    const f = fixture();
    setText(f.canonical, 4, "anything");
    assert.equal(applyOpenCodeChanges(f.messages, f.decoded, f.canonical), 0);
  });
  it("A5 user text change fills the first part and empties the rest", () => {
    const f = fixture();
    (f.canonical[0]!.content as Array<{ text: string }>)[0]!.text = "DATE\n\nfix it";
    applyOpenCodeChanges(f.messages, f.decoded, f.canonical);
    assert.deepEqual(f.messages[0]!.parts.map((p) => (p as { text: string }).text), ["DATE\n\nfix it\nplease", ""]);
  });
  it("A6 assistant text change keeps tool parts", () => {
    const f = fixture();
    setText(f.canonical, 1, "[evicted: message x]");
    applyOpenCodeChanges(f.messages, f.decoded, f.canonical);
    assert.equal((f.messages[1]!.parts[0] as { text: string }).text, "[evicted: message x]");
    f.messages[1]!.parts.slice(1).forEach((part, i) => assert.equal(part, f.originals[1]!.parts[i + 1]));
  });
  it("A7 several changes in one message produce one replacement", () => {
    const f = fixture();
    setText(f.canonical, 1, "short");
    setText(f.canonical, 2, "trimmed");
    assert.equal(applyOpenCodeChanges(f.messages, f.decoded, f.canonical), 1);
  });
});

describe("surface ids and entries", () => {
  const messages = [
    userMsg([text("one")], "msg_u1"),
    assistantMsg([text("done"), tool("c1", completed("o"), "prt_t1")], {}, "msg_a1"),
    assistantMsg([text("summary")], { summary: true }, "msg_sum"),
    userMsg([text("two")], "msg_u2"),
    assistantMsg([tool("c2", completed("old", 9), "prt_t2")], {}, "msg_a2"),
  ];
  const decoded = decodeOpenCodeMessages(messages);
  it("S1 ids", () => {
    assert.deepEqual(decoded.messages.map(openCodeSurfaceId), ["msg:msg_u1", "msg:msg_a1", "part:prt_t1", "msg:msg_sum", "msg:msg_u2", "msg:msg_a2", "part:prt_t2"]);
  });
  it("S2 turns", () => {
    assert.deepEqual(openCodeSurfaceEntries(decoded.messages, new Set()).map((e) => e.turn), [1, 1, 1, 1, 2, 2, 2]);
  });
  it("S3 checkpoints and already-evicted entries", () => {
    const entries = openCodeSurfaceEntries(decoded.messages, new Set(["part:prt_t1"]));
    assert.deepEqual(entries.filter((e) => e.checkpoint).map((e) => e.id), ["msg:msg_sum"]);
    assert.deepEqual(entries.filter((e) => e.alreadyEvicted).map((e) => e.id), ["part:prt_t1", "part:prt_t2"]);
  });
});

describe("overlay store", () => {
  it("O1 a missing overlay is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-oc-ov-"));
    assert.deepEqual(await loadOverlay(dir, S), { version: 1, sessionId: S, entries: {} });
  });
  it("O2 save and load round trip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-oc-ov-"));
    const overlay = { version: 1 as const, sessionId: S, entries: { "part:p": { text: "stub", at: "t" } } };
    await saveOverlay(dir, overlay);
    assert.deepEqual(await loadOverlay(dir, S), overlay);
  });
  it("O3 a corrupt overlay is treated as empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-oc-ov-"));
    const path = overlayPath(dir, S);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{broken");
    assert.deepEqual((await loadOverlay(dir, S)).entries, {});
  });
  it("O4 applyOverlay replaces overlaid text and keeps everything else", () => {
    const decoded = decodeOpenCodeMessages([
      userMsg([text("one")], "msg_u1"),
      assistantMsg([text("long answer"), tool("c1", completed("big"), "prt_t1")], {}, "msg_a1"),
    ]);
    const { messages, applied } = applyOverlay(decoded.messages, {
      version: 1, sessionId: S, entries: { "part:prt_t1": { text: "[evicted: tool_result part:prt_t1]", at: "t" }, "msg:msg_a1": { text: "[evicted: message]", at: "t" } },
    });
    assert.equal(applied, 2);
    assert.equal(messages[0], decoded.messages[0]);
    assert.deepEqual(messages[1]?.content, [{ type: "text", text: "[evicted: message]" }, { type: "tool_call", toolCallId: "c1", toolName: "bash", argumentsJson: { command: "make" } }]);
    assert.equal((messages[2]?.content as Array<{ text: string }>)[0]?.text, "[evicted: tool_result part:prt_t1]");
  });
});
