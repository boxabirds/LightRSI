/**
 * Regression matrix: repeat-read disclosure carried across Codex requests
 * (src/reduction.ts, src/session-state.ts)
 *
 * The tool_payload_trim pass leaves a file read untrimmed when its path was already
 * disclosed (the model re-reading a file it saw summarised wants the full body).
 * Codex resends the whole input history on every request, so the adapter must not
 * hand the pass a path whose disclosing read is still in the history: the pass would
 * then treat that same read as a repeat and send it untrimmed (prompt-cache miss).
 *
 * normalizeDisclosedReadOwners
 *   O1 non-objects/arrays → undefined; keys trimmed + lowercased, blank keys dropped;
 *      non-string or empty owners → null
 * carriedDisclosedReadPaths
 *   O2 no owners → undefined; owner present → not carried; owner absent → carried;
 *      null owner → carried
 * recordDisclosedReadOwners
 *   O3 no reported paths → unchanged; a new path is owned by the call_id of the first
 *      segment with that path; no matching segment → null; a known path keeps its owner
 * applyBeforeCallReductionToPayload + snapshot (as the proxy persists it)
 *   D1 the same read still in history on the next request stays trimmed and
 *      byte-identical (regression)
 *   D2 once the disclosing read has left history, a new read of the same path is sent
 *      in full (existing progressive-disclosure behaviour kept)
 *   D3 a legacy snapshot with only disclosedReadPaths (no owners) is ignored: the read
 *      is trimmed
 *   D4 owners round-trip through upsertCodexSessionSnapshot and survive
 *      mergeCodexSessionSnapshot
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ContextSegment } from "@lightrsi/kernel";

import { normalizeTokenPilotCodexConfig } from "../src/config.js";
import {
  applyBeforeCallReductionToPayload,
  carriedDisclosedReadPaths,
  normalizeDisclosedReadOwners,
  recordDisclosedReadOwners,
} from "../src/reduction.js";
import { loadCodexSessionSnapshot, mergeCodexSessionSnapshot, upsertCodexSessionSnapshot } from "../src/session-state.js";

const CODE = Array.from({ length: 400 }, (_, i) => `export function handler${i}(input: string): string {\n  return input.trim() + "${i}";\n}\n`).join("\n");
const PATH = "/repo/src/handlers.ts";

async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), "codex-disclosed-"));
  return { stateDir, config: normalizeTokenPilotCodexConfig({ stateDir }) };
}

const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
function readTurn(callId: string) {
  return [
    { type: "function_call", call_id: callId, name: "Read", arguments: JSON.stringify({ path: PATH }) },
    { type: "function_call_output", call_id: callId, output: CODE },
  ];
}
const shellTurn = [
  { type: "function_call", call_id: "call_sh", name: "shell", arguments: JSON.stringify({ command: ["echo", "hi"] }) },
  { type: "function_call_output", call_id: "call_sh", output: "hi" },
];

/** One proxy request: reduce, then persist the disclosure fields the way the proxy does after the response. */
async function request(env: Awaited<ReturnType<typeof setup>>, sessionId: string, input: unknown[]) {
  const payload: any = { model: "m", input: structuredClone(input) };
  const summary = await applyBeforeCallReductionToPayload({ payload, sessionId, config: env.config });
  await upsertCodexSessionSnapshot(env.stateDir, sessionId, {
    disclosedReadPaths: summary.disclosedReadPaths,
    disclosedReadOwners: summary.disclosedReadOwners,
  });
  return { payload, summary };
}

test("O1 normalizeDisclosedReadOwners", () => {
  for (const junk of [undefined, null, "x", 3, ["/a"]]) assert.equal(normalizeDisclosedReadOwners(junk), undefined);
  assert.deepEqual(
    normalizeDisclosedReadOwners({ " /Repo/A.ts ": "call_1", "  ": "call_2", "/b": 5, "/c": "", "/d": null }),
    { "/repo/a.ts": "call_1", "/b": null, "/c": null, "/d": null },
  );
});

test("O2 carriedDisclosedReadPaths", () => {
  assert.equal(carriedDisclosedReadPaths(undefined, new Set()), undefined);
  const owners = { "/present": "call_1", "/gone": "call_2", "/unowned": null };
  assert.deepEqual(carriedDisclosedReadPaths(owners, new Set(["call_1"])), ["/gone", "/unowned"]);
  assert.equal(carriedDisclosedReadPaths({ "/present": "call_1" }, new Set(["call_1"])), undefined);
});

test("O3 recordDisclosedReadOwners", () => {
  const segments = [
    { id: "input-2-output", kind: "volatile", text: "x", priority: 0, metadata: { path: "/Repo/A.ts" } },
    { id: "input-4-output", kind: "volatile", text: "x", priority: 0, metadata: { path: "/repo/a.ts" } },
  ] as ContextSegment[];
  const bindings = [
    { segmentId: "input-2-output", itemIndex: 2, field: "output" as const, callId: "call_first" },
    { segmentId: "input-4-output", itemIndex: 4, field: "output" as const, callId: "call_second" },
  ];
  const known = { "/known": "call_old" };
  assert.equal(recordDisclosedReadOwners(known, undefined, segments, bindings), known);
  assert.deepEqual(
    recordDisclosedReadOwners(known, ["/repo/a.ts", "/elsewhere.ts", "/known"], segments, bindings),
    { "/known": "call_old", "/repo/a.ts": "call_first", "/elsewhere.ts": null },
  );
});

test("D1 the same read still in history stays trimmed on the next request", async () => {
  const env = await setup();
  const first = await request(env, "d1", [user("read it"), ...readTurn("call_r1")]);
  assert.ok(String(first.payload.input[2].output).length < CODE.length, "precondition: the first read is trimmed");
  const second = await request(env, "d1", [user("read it"), ...readTurn("call_r1"), ...shellTurn]);
  assert.equal(String(second.payload.input[2].output), String(first.payload.input[2].output));
});

test("D2 a new read of the same path after the first left history is sent in full", async () => {
  const env = await setup();
  const first = await request(env, "d2", [user("read it"), ...readTurn("call_r1")]);
  assert.ok(String(first.payload.input[2].output).length < CODE.length);
  const second = await request(env, "d2", [user("summary, then read it again in full"), ...readTurn("call_r2")]);
  assert.equal(second.payload.input[2].output, CODE);
});

test("D3 a legacy snapshot without owners does not force reads untrimmed", async () => {
  const env = await setup();
  await upsertCodexSessionSnapshot(env.stateDir, "d3", { disclosedReadPaths: [PATH] });
  const out = await request(env, "d3", [user("read it"), ...readTurn("call_r1")]);
  assert.ok(String(out.payload.input[2].output).length < CODE.length);
});

test("D4 owners round-trip through the snapshot and survive a session merge", async () => {
  const env = await setup();
  await request(env, "d4-source", [user("read it"), ...readTurn("call_r1")]);
  assert.deepEqual((await loadCodexSessionSnapshot(env.stateDir, "d4-source"))?.disclosedReadOwners, { [PATH]: "call_r1" });
  await upsertCodexSessionSnapshot(env.stateDir, "d4-source", { lastToolName: "shell" });
  assert.deepEqual((await loadCodexSessionSnapshot(env.stateDir, "d4-source"))?.disclosedReadOwners, { [PATH]: "call_r1" });
  const merged = await mergeCodexSessionSnapshot(env.stateDir, "d4-source", "d4-target");
  assert.deepEqual(merged?.disclosedReadOwners, { [PATH]: "call_r1" });
});
