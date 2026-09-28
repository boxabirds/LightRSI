/**
 * Regression matrix: adapters/shared/canonical/eviction.ts
 *
 * surfaceItemKind — one case per class
 *   K1 checkpoint → compaction_checkpoint   K2 tool role → tool_result
 *   K3 assistant with tool_call → tool_call K4 assistant text only → message
 *   K5 user → message
 * buildCanonicalRawSemanticSnapshot
 *   N1 user/assistant text → message records anchored to their turn
 *   N2 blank text → no message record
 *   N3 tool_call → tool call record (argumentsText from JSON args, summary ≤ 600 chars)
 *   N4 tool_result → result record (status, tool name from block, else from call)
 *   N5 lastTurnSeq = max turn
 * buildCanonicalSurfaceItems
 *   I1 ids, turns, kinds and chars carried through
 *   I2 callIds only on tool_call / tool_result items
 * buildEvictionReplacement
 *   X1 stub text `[evicted: <kind> <id>]` + shared recovery hint, dataKey `evicted:<id>`
 *   X2 the original is recoverable via the shared resolveMemoryFaultRecover
 *   X3 empty original → stub only, no archive
 *   X4 archive write failure → throws (never evict without a recoverable original)
 * createCanonicalEstimator
 *   E1 incomplete estimator config → undefined;  E2 complete → estimator
 * runCanonicalSurfaceEviction (fake estimator, in-memory registry store)
 *   V1 completed earlier turn → its large tool result is replaced; call envelope kept
 *   V2 alreadyEvicted entries are neither re-evicted nor counted as effective
 *   V3 checkpoints are never evicted
 *   V4 eviction.enabled=false → apply never called, registry still updated
 *   V5 host apply reports deferred → no replacements returned, watermark behind
 *   V6 archive failure → batch deferred, apply never called
 *   V7 current turn is never evicted
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureStatePathResolver } from "@lightrsi/artifact-store";
import type { SemanticTaskUpdate } from "@lightrsi/eviction";
import { createEmptySessionTaskRegistry, type SessionTaskRegistry } from "@lightrsi/history";
import { createStaticStatePathResolver } from "@lightrsi/host-adapter";
import type { RuntimeMessage } from "@lightrsi/kernel";
import { resolveMemoryFaultRecover } from "@lightrsi/mcp";

import { normalizeCanonicalAdapterConfig } from "../../shared/canonical/config.js";
import {
  buildCanonicalRawSemanticSnapshot,
  buildCanonicalSurfaceItems,
  buildEvictionReplacement,
  createCanonicalEstimator,
  runCanonicalSurfaceEviction,
  surfaceItemKind,
  type CanonicalSurfaceEntry,
} from "../../shared/canonical/eviction.js";

const SESSION = "s-ev";
const BIG = "x".repeat(6000);

async function freshState(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tp-ev-"));
  configureStatePathResolver(createStaticStatePathResolver({ hostId: "pi", displayName: "pi", stateDir: dir, namespaceDir: "tokenpilot" }));
  return dir;
}

const user = (text: string): RuntimeMessage => ({ role: "user", content: text });
const assistantText = (text: string): RuntimeMessage => ({ role: "assistant", content: [{ type: "text", text }] });
const call = (id: string, toolName = "read"): RuntimeMessage => ({
  role: "assistant",
  content: [{ type: "tool_call", toolCallId: id, toolName, argumentsJson: { path: "/cfg" } }],
});
const result = (id: string, text: string, toolName?: string): RuntimeMessage => ({
  role: "tool",
  content: [{ type: "tool_result", toolCallId: id, ...(toolName ? { toolName } : {}), status: "success", text }],
});

/** Turn 1 finished a task with a big tool result; turn 2 is current. */
function surface(): CanonicalSurfaceEntry[] {
  return [
    { id: "u1", turn: 1, message: user("read the config") },
    { id: "a1", turn: 1, message: call("c1") },
    { id: "r1", turn: 1, message: result("c1", BIG) },
    { id: "a1b", turn: 1, message: assistantText(`config says x. ${"detail ".repeat(700)}`) },
    { id: "u2", turn: 2, message: user("now something else") },
    { id: "r2", turn: 2, message: result("c2", BIG) },
  ];
}

function completedEstimator(): { estimate(): { baseVersion: number; taskUpdates: SemanticTaskUpdate[] } } {
  return {
    estimate: () => ({
      baseVersion: 0,
      taskUpdates: [{
        taskId: "task-config",
        objective: "read the config",
        lifecycle: "completed",
        coveredTurnAbsIds: [`${SESSION}:t1`],
        completionEvidence: ["reported config value"],
      }],
    }),
  };
}

function memoryStore(initial = createEmptySessionTaskRegistry(SESSION)) {
  let current: SessionTaskRegistry = initial;
  return {
    get: () => current,
    load: () => current,
    persist: (registry: SessionTaskRegistry) => { current = registry; },
  };
}

const enabledConfig = (stateDir: string, patch: Record<string, unknown> = {}) => normalizeCanonicalAdapterConfig({
  stateDir,
  modules: { eviction: true },
  eviction: { enabled: true, minBlockChars: 256 },
  taskStateEstimator: { baseUrl: "http://x", apiKey: "k", model: "m" },
  ...patch,
}, { defaultStateDir: stateDir });

describe("surfaceItemKind", () => {
  it("K1 checkpoint", () => assert.equal(surfaceItemKind({ id: "x", turn: 1, message: user("s"), checkpoint: true }), "compaction_checkpoint"));
  it("K2 tool role", () => assert.equal(surfaceItemKind({ id: "x", turn: 1, message: result("c", "o") }), "tool_result"));
  it("K3 assistant with a call", () => assert.equal(surfaceItemKind({ id: "x", turn: 1, message: call("c") }), "tool_call"));
  it("K4 assistant text only", () => assert.equal(surfaceItemKind({ id: "x", turn: 1, message: assistantText("t") }), "message"));
  it("K5 user", () => assert.equal(surfaceItemKind({ id: "x", turn: 1, message: user("t") }), "message"));
});

describe("buildCanonicalRawSemanticSnapshot", () => {
  const snap = () => buildCanonicalRawSemanticSnapshot(SESSION, [
    { id: "u1", turn: 1, message: user("read it") },
    { id: "blank", turn: 1, message: assistantText("   ") },
    { id: "a1", turn: 1, message: { role: "assistant", content: [{ type: "tool_call", toolCallId: "c1", toolName: "read", argumentsJson: { path: "p".repeat(900) } }] } },
    { id: "r1", turn: 1, message: result("c1", "out") },
    { id: "r1e", turn: 3, message: { role: "tool", content: [{ type: "tool_result", toolCallId: "c9", toolName: "bash", status: "error", text: "boom" }] } },
  ]);
  it("N1 text messages are anchored to their turn", () => {
    assert.deepEqual(snap().messages, [{ anchor: { sessionId: SESSION, turnAbsId: `${SESSION}:t1`, turnSeq: 1, role: "user" }, role: "user", text: "read it" }]);
  });
  it("N2 blank text produces no record", () => {
    assert.equal(snap().messages.length, 1);
  });
  it("N3 tool calls carry JSON argument text and a bounded summary", () => {
    const record = snap().toolCalls[0];
    assert.equal(record?.toolName, "read");
    assert.ok(record?.argumentsText?.startsWith('{"path":"ppp'));
    assert.ok((record?.argumentsSummary.length ?? 0) <= 603);
  });
  it("N4 tool results carry status and resolve the tool name from the call", () => {
    const [ok, err] = snap().toolResults;
    assert.deepEqual([ok?.toolName, ok?.status, ok?.fullText], ["read", "success", "out"]);
    assert.deepEqual([err?.toolName, err?.status], ["bash", "error"]);
  });
  it("N5 lastTurnSeq is the highest turn", () => {
    assert.equal(snap().lastTurnSeq, 3);
  });
});

describe("buildCanonicalSurfaceItems", () => {
  it("I1/I2 ids, turns, kinds, chars and call ids", () => {
    assert.deepEqual(buildCanonicalSurfaceItems(surface().slice(0, 3)), [
      { sourceEventSeq: "u1", turn: 1, kind: "message", chars: 15 },
      { sourceEventSeq: "a1", turn: 1, kind: "tool_call", callIds: ["c1"], chars: 0 },
      { sourceEventSeq: "r1", turn: 1, kind: "tool_result", callIds: ["c1"], chars: 6000 },
    ]);
  });
});

describe("buildEvictionReplacement", () => {
  it("X1/X2 stub + recovery hint, and the original is recoverable", async () => {
    const stateDir = await freshState();
    const replacement = await buildEvictionReplacement({ sessionId: SESSION, entry: { id: "r1", turn: 1, message: result("c1", BIG, "read") } });
    assert.ok(replacement.text.startsWith("[evicted: tool_result r1]"));
    assert.equal(replacement.dataKey, "evicted:r1");
    assert.ok(replacement.text.includes('"dataKey":"evicted:r1"'));
    assert.equal(replacement.originalChars, BIG.length);
    const recovered = await resolveMemoryFaultRecover({ dataKey: "evicted:r1", stateDir });
    assert.ok(recovered.text.includes(BIG.slice(0, 100)));
  });
  it("X3 an empty original yields a stub without a hint", async () => {
    await freshState();
    const replacement = await buildEvictionReplacement({ sessionId: SESSION, entry: { id: "e", turn: 1, message: result("c", "") } });
    assert.equal(replacement.text, "[evicted: tool_result e]");
  });
  it("X4 an unwritable archive throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-ev-"));
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "file, not a dir");
    configureStatePathResolver(createStaticStatePathResolver({ hostId: "pi", displayName: "pi", stateDir: blocker, namespaceDir: "tokenpilot" }));
    await assert.rejects(buildEvictionReplacement({ sessionId: SESSION, entry: { id: "r1", turn: 1, message: result("c1", BIG) } }));
  });
});

describe("createCanonicalEstimator", () => {
  it("E1 incomplete config yields no estimator", () => {
    assert.equal(createCanonicalEstimator(normalizeCanonicalAdapterConfig({ taskStateEstimator: { baseUrl: "http://x" } }, { defaultStateDir: "/s" })), undefined);
  });
  it("E2 complete config yields an estimator", () => {
    assert.equal(typeof createCanonicalEstimator(enabledConfig("/s"))?.estimate, "function");
  });
});

describe("runCanonicalSurfaceEviction", () => {
  it("V1 a completed turn's large result and message are replaced; the call envelope is kept", async () => {
    const stateDir = await freshState();
    const store = memoryStore();
    let applied: string[] = [];
    const cycle = await runCanonicalSurfaceEviction({
      sessionId: SESSION, entries: surface(), config: enabledConfig(stateDir), estimator: completedEstimator(), registryStore: store,
      apply(replacements) { applied = replacements.map((r) => r.id); return "committed"; },
    });
    assert.deepEqual(applied, ["r1", "a1b"]);
    assert.equal(cycle.status, "applied");
    assert.equal(cycle.result.replacements.length, 2);
    assert.equal(store.get().lastProcessedTurnSeq, 2);
  });
  it("V2 already-evicted entries are not evicted again", async () => {
    const stateDir = await freshState();
    const entries = surface().map((entry) => (entry.id === "r1" ? { ...entry, alreadyEvicted: true } : entry));
    let applied: string[] = [];
    await runCanonicalSurfaceEviction({
      sessionId: SESSION, entries, config: enabledConfig(stateDir), estimator: completedEstimator(), registryStore: memoryStore(),
      apply(replacements) { applied = replacements.map((r) => r.id); return "committed"; },
    });
    assert.deepEqual(applied, ["a1b"]);
  });
  it("V3 checkpoints are never evicted", async () => {
    const stateDir = await freshState();
    const entries = surface().map((entry) => (entry.id === "a1b" ? { ...entry, checkpoint: true } : entry));
    let applied: string[] = [];
    await runCanonicalSurfaceEviction({
      sessionId: SESSION, entries, config: enabledConfig(stateDir), estimator: completedEstimator(), registryStore: memoryStore(),
      apply(replacements) { applied = replacements.map((r) => r.id); return "committed"; },
    });
    assert.deepEqual(applied, ["r1"]);
  });
  it("V4 eviction disabled tracks task state without applying", async () => {
    const stateDir = await freshState();
    const store = memoryStore();
    let called = false;
    await runCanonicalSurfaceEviction({
      sessionId: SESSION, entries: surface(), config: enabledConfig(stateDir, { eviction: { enabled: false } }), estimator: completedEstimator(), registryStore: store,
      apply() { called = true; return "committed"; },
    });
    assert.equal(called, false);
    assert.deepEqual(store.get().completedTaskIds, ["task-config"]);
  });
  it("V5 a deferred host apply returns no replacements and keeps the watermark", async () => {
    const stateDir = await freshState();
    const store = memoryStore();
    const cycle = await runCanonicalSurfaceEviction({
      sessionId: SESSION, entries: surface(), config: enabledConfig(stateDir), estimator: completedEstimator(), registryStore: store,
      apply: () => "deferred",
    });
    assert.equal(cycle.status, "deferred");
    assert.deepEqual(cycle.result.replacements, []);
    assert.equal(store.get().lastProcessedTurnSeq, 0);
  });
  it("V6 an archive failure defers the batch without calling apply", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-ev-"));
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "file");
    configureStatePathResolver(createStaticStatePathResolver({ hostId: "pi", displayName: "pi", stateDir: blocker, namespaceDir: "tokenpilot" }));
    let called = false;
    const cycle = await runCanonicalSurfaceEviction({
      sessionId: SESSION, entries: surface(), config: enabledConfig(dir), estimator: completedEstimator(), registryStore: memoryStore(),
      apply() { called = true; return "committed"; },
    });
    assert.equal(called, false);
    assert.equal(cycle.status, "deferred");
  });
  it("V7 the current turn is never evicted", async () => {
    const stateDir = await freshState();
    let applied: string[] = [];
    await runCanonicalSurfaceEviction({
      sessionId: SESSION, entries: surface(), config: enabledConfig(stateDir), estimator: completedEstimator(), registryStore: memoryStore(),
      apply(replacements) { applied = replacements.map((r) => r.id); return "committed"; },
    });
    assert.ok(!applied.includes("u2") && !applied.includes("r2"));
  });
});
