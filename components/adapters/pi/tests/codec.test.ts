/**
 * Regression matrix: pi/src/codec.ts (pi AgentMessage ↔ canonical transcript bridge)
 *
 * decodePiMessage — one case per pi role
 *   D1 user string content          → user, same string
 *   D2 user parts (text + image)    → user text/image blocks (image keeps mimeType only)
 *   D3 assistant text/toolCall/thinking → text + tool_call blocks; thinking in metadata.reasoning
 *   D4 toolResult (text + image, error) → tool role, one tool_result (joined text, error status,
 *      imageParts count)
 *   D5 bashExecution / custom / branchSummary / compactionSummary / unknown → user pass-through
 *      with their visible text
 *   D6 malformed (non-object, missing content) → pass-through, never throws
 *   D7 metadata carries piIndex and piRole
 * encodePiMessages
 *   E1 round trip: encode(original, decode(original)) returns the SAME objects
 *   E2 changed tool-result text → cloned toolResult with new text first, images kept, other
 *      fields identical; original untouched
 *   E3 changed user string content → cloned user with new string
 *   E4 changed user parts → cloned user with new text part first, images kept
 *   E5 changes on assistant / pass-through messages are ignored (not writable)
 *   E6 a shorter canonical array leaves the remaining originals untouched
 * piProjectionToSurfaceEntries (projected branch → surface entries)
 *   P1 message entries become items with the entry id; turn increments on each user message
 *   P2 compaction / branch_summary / custom_message entries become checkpoints (`<id>#<n>`)
 *   P3 system messages and empty projections are skipped
 *   P4 an entry already replaced by an eviction stub is flagged alreadyEvicted
 *   P5 pass-through roles inside message entries (bashExecution) are checkpoints
 * piReplacementContent
 *   R1 user with string content → string;  R2 everything else → single text part
 * Round-trip fixtures cover tool calls/results, reasoning, images, branch and compaction entries.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  decodePiMessage,
  decodePiMessages,
  encodePiMessages,
  piProjectionToSurfaceEntries,
  piReplacementContent,
} from "../src/codec.js";
import type { PiAgentMessage, PiProjectedSessionEntry } from "../src/pi-types.js";

const IMAGE = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" } as const;

function transcript(): PiAgentMessage[] {
  return [
    { role: "user", content: "fix the build", timestamp: 1 },
    { role: "user", content: [{ type: "text", text: "see screenshot" }, IMAGE], timestamp: 2 },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan: run make" },
        { type: "text", text: "Running make." },
        { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "make" } },
      ],
      model: "qwen",
      timestamp: 3,
    },
    { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "ok\n" }, { type: "text", text: "done" }, IMAGE], isError: true, timestamp: 4 },
    { role: "bashExecution", command: "ls", output: "a b", exitCode: 0, cancelled: false, truncated: false, timestamp: 5 },
    { role: "custom", customType: "note", content: "remember this", display: true, timestamp: 6 },
    { role: "branchSummary", summary: "tried X", fromId: null, timestamp: 7 },
    { role: "compactionSummary", summary: "earlier work", tokensBefore: 900, timestamp: 8 },
  ];
}

describe("decodePiMessage", () => {
  const decoded = decodePiMessages(transcript());
  it("D1 user string content", () => {
    assert.deepEqual(decoded[0], { role: "user", content: "fix the build", metadata: { piIndex: 0, piRole: "user" } });
  });
  it("D2 user text and image parts", () => {
    assert.deepEqual(decoded[1]?.content, [{ type: "text", text: "see screenshot" }, { type: "image", mediaType: "image/png" }]);
  });
  it("D3 assistant text, tool call and reasoning", () => {
    assert.deepEqual(decoded[2], {
      role: "assistant",
      content: [
        { type: "text", text: "Running make." },
        { type: "tool_call", toolCallId: "call_1", toolName: "bash", argumentsJson: { command: "make" } },
      ],
      metadata: { piIndex: 2, piRole: "assistant", reasoning: ["plan: run make"] },
    });
  });
  it("D4 tool result with text, error status and images", () => {
    assert.deepEqual(decoded[3], {
      role: "tool",
      content: [{ type: "tool_result", toolCallId: "call_1", toolName: "bash", status: "error", text: "ok\n\ndone" }],
      metadata: { piIndex: 3, piRole: "toolResult", imageParts: 1 },
    });
  });
  it("D5 pi-specific roles are user pass-through with visible text", () => {
    assert.deepEqual(decoded.slice(4).map((m) => [m.role, m.content, m.metadata?.lightrsiPassThrough]), [
      ["user", "$ ls\na b", true],
      ["user", "remember this", true],
      ["user", "tried X", true],
      ["user", "earlier work", true],
    ]);
    assert.equal(decodePiMessage({ role: "futureRole", content: [{ type: "text", text: "t" }] }, 0).content, "t");
  });
  it("D6 malformed input never throws", () => {
    assert.doesNotThrow(() => decodePiMessage(null as unknown as PiAgentMessage, 0));
    assert.equal(decodePiMessage(null as unknown as PiAgentMessage, 0).metadata?.lightrsiPassThrough, true);
    assert.deepEqual(decodePiMessage({ role: "assistant" } as PiAgentMessage, 0).content, []);
    assert.deepEqual(decodePiMessage({ role: "toolResult" } as PiAgentMessage, 0).content, [{ type: "tool_result", toolCallId: undefined, toolName: undefined, status: "success", text: "" }]);
  });
  it("D7 metadata carries index and role", () => {
    assert.deepEqual(decoded.map((m) => m.metadata?.piIndex), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(decoded[6]?.metadata?.piRole, "branchSummary");
  });
});

describe("encodePiMessages", () => {
  it("E1 an unchanged round trip returns the same objects", () => {
    const original = transcript();
    const encoded = encodePiMessages(original, decodePiMessages(original));
    assert.equal(encoded.length, original.length);
    encoded.forEach((message, index) => assert.equal(message, original[index], `index ${index}`));
  });
  it("E2 changed tool-result text clones the message and keeps images", () => {
    const original = transcript();
    const snapshot = JSON.stringify(original);
    const canonical = decodePiMessages(original);
    canonical[3] = { ...canonical[3]!, content: [{ type: "tool_result", toolCallId: "call_1", toolName: "bash", status: "error", text: "trimmed" }] };
    const encoded = encodePiMessages(original, canonical);
    assert.notEqual(encoded[3], original[3]);
    assert.deepEqual(encoded[3], { ...original[3], content: [{ type: "text", text: "trimmed" }, IMAGE] });
    assert.equal(JSON.stringify(original), snapshot, "original mutated");
  });
  it("E3 changed user string content", () => {
    const original = transcript();
    const canonical = decodePiMessages(original);
    canonical[0] = { ...canonical[0]!, content: "DATE\n\nfix the build" };
    assert.deepEqual(encodePiMessages(original, canonical)[0], { role: "user", content: "DATE\n\nfix the build", timestamp: 1 });
  });
  it("E4 changed user parts keep images after the new text", () => {
    const original = transcript();
    const canonical = decodePiMessages(original);
    canonical[1] = { ...canonical[1]!, content: [{ type: "text", text: "new" }, { type: "image", mediaType: "image/png" }] };
    assert.deepEqual(encodePiMessages(original, canonical)[1], { role: "user", content: [{ type: "text", text: "new" }, IMAGE], timestamp: 2 });
  });
  it("E5 assistant and pass-through changes are ignored", () => {
    const original = transcript();
    const canonical = decodePiMessages(original);
    canonical[2] = { ...canonical[2]!, content: [{ type: "text", text: "rewritten" }] };
    canonical[5] = { ...canonical[5]!, content: "rewritten" };
    const encoded = encodePiMessages(original, canonical);
    assert.equal(encoded[2], original[2]);
    assert.equal(encoded[5], original[5]);
  });
  it("E6 a shorter canonical array leaves remaining messages untouched", () => {
    const original = transcript();
    const encoded = encodePiMessages(original, decodePiMessages(original).slice(0, 2));
    encoded.forEach((message, index) => assert.equal(message, original[index]));
  });
});

describe("piProjectionToSurfaceEntries", () => {
  const entry = (id: string, type: string, messages: PiAgentMessage[]): PiProjectedSessionEntry => ({
    sourceEntry: { type, id, parentId: null, timestamp: "t" },
    messages,
  });
  function projection(): PiProjectedSessionEntry[] {
    const t = transcript();
    return [
      entry("cmp", "compaction", [{ role: "system", content: "checkpoint" }, t[7]!]),
      entry("e1", "message", [t[0]!]),
      entry("e2", "message", [t[2]!]),
      entry("e3", "message", [t[3]!]),
      entry("bs", "branch_summary", [t[6]!]),
      entry("cm", "custom_message", [t[5]!]),
      entry("bx", "message", [t[4]!]),
      entry("st", "custom", []),
      entry("e4", "message", [{ role: "user", content: "next", timestamp: 9 }]),
      entry("e5", "message", [{ role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "[evicted: tool_result e5]\n\nhint" }], isError: false, timestamp: 10 }]),
    ];
  }
  const entries = () => piProjectionToSurfaceEntries(projection());

  it("P1 message entries keep their id and turns start at user messages", () => {
    assert.deepEqual(entries().filter((e) => !e.checkpoint).map((e) => [e.id, e.turn]), [["e1", 1], ["e2", 1], ["e3", 1], ["e4", 2], ["e5", 2]]);
  });
  it("P2 compaction, branch summary and custom messages are checkpoints", () => {
    assert.deepEqual(entries().filter((e) => e.checkpoint).map((e) => e.id), ["cmp#1", "bs#0", "cm#0", "bx"]);
  });
  it("P3 system messages and empty projections are skipped", () => {
    const ids = entries().map((e) => e.id);
    assert.ok(!ids.includes("cmp#0"));
    assert.ok(!ids.some((id) => id.startsWith("st")));
  });
  it("P4 eviction stubs are flagged alreadyEvicted", () => {
    assert.deepEqual(entries().filter((e) => e.alreadyEvicted).map((e) => e.id), ["e5"]);
  });
  it("P5 bashExecution inside a message entry is a checkpoint", () => {
    assert.equal(entries().find((e) => e.id === "bx")?.checkpoint, true);
  });
  it("malformed projections are skipped, not thrown", () => {
    assert.deepEqual(piProjectionToSurfaceEntries([null as unknown as PiProjectedSessionEntry, { sourceEntry: { type: "message" } } as unknown as PiProjectedSessionEntry]), []);
  });
});

describe("piReplacementContent", () => {
  it("R1 a user message with string content gets a string", () => {
    assert.equal(piReplacementContent({ role: "user", content: "x", timestamp: 1 }, "stub"), "stub");
  });
  it("R2 everything else gets a single text part", () => {
    assert.deepEqual(piReplacementContent({ role: "toolResult", toolCallId: "c", toolName: "b", content: [], isError: false, timestamp: 1 }, "stub"), [{ type: "text", text: "stub" }]);
    assert.deepEqual(piReplacementContent({ role: "user", content: [{ type: "text", text: "x" }], timestamp: 1 }, "stub"), [{ type: "text", text: "stub" }]);
    assert.deepEqual(piReplacementContent(undefined, "stub"), [{ type: "text", text: "stub" }]);
  });
});
