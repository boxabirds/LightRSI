/**
 * Regression matrix: repeat-read disclosure carried across Claude Code requests
 * (src/reduction.ts, src/session-state.ts, src/context-cleaner/session-catalog.ts)
 *
 * The tool_payload_trim pass leaves a file read untrimmed when its path was already
 * disclosed (the model re-reading a file it saw summarised wants the full body).
 * Claude Code resends the whole history on every request, so the adapter must not
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
 *   O3 no reported paths → unchanged; a new path is owned by the tool_use_id of the
 *      first eligible trimmed read with that path; no matching segment → null; a
 *      known path keeps its owner
 *   O4 a non-read tool using the same path cannot become the disclosure owner
 *   O5 owners not present in the bounded reported path set are discarded
 * applyBeforeCallReductionToClaudePayload + snapshot (as the gateway persists it)
 *   D1 the same read still in history on the next request stays trimmed and
 *      byte-identical (regression)
 *   D2 once the disclosing read has left history, a new read of the same path is sent
 *      in full (existing progressive-disclosure behaviour kept)
 *   D3 a legacy snapshot with only disclosedReadPaths (no owners) is ignored: the read
 *      is trimmed
 *   D4 owners round-trip through upsertClaudeCodeSessionSnapshot
 *   D5 when two reads share a path, ownership follows the read actually trimmed;
 *      removing an earlier untrimmed read does not make the retained read expand
 * session catalog
 *   C1 a snapshot with valid owners is listed; one with a non-string owner is not
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ContextSegment } from "@lightrsi/kernel";

import { normalizeTokenPilotClaudeCodeConfig } from "../src/config.js";
import { listClaudeCleanerSessions } from "../src/context-cleaner/session-catalog.js";
import {
  applyBeforeCallReductionToClaudePayload,
  carriedDisclosedReadPaths,
  normalizeDisclosedReadOwners,
  recordDisclosedReadOwners,
} from "../src/reduction.js";
import { loadClaudeCodeSessionSnapshot, upsertClaudeCodeSessionSnapshot } from "../src/session-state.js";

const CODE = Array.from({ length: 400 }, (_, i) => `export function handler${i}(input: string): string {\n  return input.trim() + "${i}";\n}\n`).join("\n");
const PATH = "/repo/src/handlers.ts";

async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), "cc-disclosed-"));
  return { stateDir, config: normalizeTokenPilotClaudeCodeConfig({ stateDir }) };
}

function readTurn(id: string) {
  return readTurnWithContent(id, CODE);
}

function readTurnWithContent(id: string, content: string) {
  return [
    { role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: { file_path: PATH } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  ];
}

const writeTurn = [
  { role: "assistant", content: [{ type: "tool_use", id: "toolu_w", name: "Write", input: { file_path: "/repo/out.txt", content: "x" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_w", content: "wrote 1 byte" }] },
];

const resultText = (payload: any, messageIndex: number) => String(payload.messages[messageIndex].content[0].content);

/** One gateway request: reduce, then persist the summary's disclosure fields the way recordClaudeGatewayTurn does. */
async function request(env: Awaited<ReturnType<typeof setup>>, sessionId: string, messages: unknown[]) {
  const payload: any = { model: "m", messages: structuredClone(messages) };
  const summary = await applyBeforeCallReductionToClaudePayload({ payload, sessionId, config: env.config });
  await upsertClaudeCodeSessionSnapshot(env.stateDir, sessionId, {
    disclosedReadPaths: summary.disclosedReadPaths,
    disclosedReadOwners: summary.disclosedReadOwners,
  });
  return { payload, summary };
}

test("O1 normalizeDisclosedReadOwners", () => {
  for (const junk of [undefined, null, "x", 3, ["/a"]]) assert.equal(normalizeDisclosedReadOwners(junk), undefined);
  assert.deepEqual(
    normalizeDisclosedReadOwners({ " /Repo/A.ts ": "toolu_1", "  ": "toolu_2", "/b": 5, "/c": "", "/d": null }),
    { "/repo/a.ts": "toolu_1", "/b": null, "/c": null, "/d": null },
  );
});

test("O2 carriedDisclosedReadPaths", () => {
  assert.equal(carriedDisclosedReadPaths(undefined, new Set()), undefined);
  const owners = { "/present": "toolu_1", "/gone": "toolu_2", "/unowned": null };
  assert.deepEqual(carriedDisclosedReadPaths(owners, new Set(["toolu_1"])), ["/gone", "/unowned"]);
  assert.equal(carriedDisclosedReadPaths({ "/present": "toolu_1" }, new Set(["toolu_1"])), undefined);
});

test("O3 recordDisclosedReadOwners", () => {
  const segments = [
    { id: "message-1-block-0", kind: "volatile", text: "x", priority: 0, metadata: { path: "/Repo/A.ts" } },
    { id: "message-3-block-0", kind: "volatile", text: "x", priority: 0, metadata: { path: "/repo/a.ts" } },
  ] as ContextSegment[];
  const bindings = [
    { segmentId: "message-1-block-0", messageIndex: 1, blockIndex: 0, field: "content" as const, toolName: "Read", toolUseId: "toolu_first" },
    { segmentId: "message-3-block-0", messageIndex: 3, blockIndex: 0, field: "content" as const, toolName: "Read", toolUseId: "toolu_second" },
  ];
  const known = { "/known": "toolu_old" };
  assert.equal(recordDisclosedReadOwners(known, undefined, segments, bindings, new Set()), known);
  assert.deepEqual(
    recordDisclosedReadOwners(
      known,
      ["/repo/a.ts", "/elsewhere.ts", "/known"],
      segments,
      bindings,
      new Set(["message-1-block-0", "message-3-block-0"]),
    ),
    { "/known": "toolu_old", "/repo/a.ts": "toolu_first", "/elsewhere.ts": null },
  );
});

test("O4 recordDisclosedReadOwners assigns a same-path disclosure only to a read", () => {
  const segments = [
    { id: "write-result", kind: "volatile", text: "wrote 1 byte", priority: 0, metadata: { path: "/repo/a.ts" } },
    { id: "read-result", kind: "volatile", text: "file contents", priority: 0, metadata: { path: "/repo/a.ts" } },
  ] as ContextSegment[];
  const bindings = [
    { segmentId: "write-result", messageIndex: 1, blockIndex: 0, field: "content" as const, toolName: "Write", toolUseId: "toolu_write" },
    { segmentId: "read-result", messageIndex: 3, blockIndex: 0, field: "content" as const, toolName: "Read", toolUseId: "toolu_read" },
  ];

  assert.deepEqual(
    recordDisclosedReadOwners(
      undefined,
      ["/repo/a.ts"],
      segments,
      bindings,
      new Set(["write-result", "read-result"]),
    ),
    { "/repo/a.ts": "toolu_read" },
  );
});

test("O5 recordDisclosedReadOwners keeps only the bounded reported path set", () => {
  const existing = Object.fromEntries(
    Array.from({ length: 130 }, (_, index) => [`/repo/file-${index}.ts`, `toolu_${index}`]),
  );
  const reported = Array.from({ length: 128 }, (_, index) => `/repo/file-${index + 2}.ts`);

  const owners = recordDisclosedReadOwners(existing, reported, [], [], new Set());

  assert.equal(Object.keys(owners ?? {}).length, 128);
  assert.equal(owners?.["/repo/file-0.ts"], undefined);
  assert.equal(owners?.["/repo/file-1.ts"], undefined);
  assert.equal(owners?.["/repo/file-2.ts"], "toolu_2");
  assert.equal(owners?.["/repo/file-129.ts"], "toolu_129");
});

test("D1 the same read still in history stays trimmed on the next request", async () => {
  const env = await setup();
  const first = await request(env, "d1", [{ role: "user", content: [{ type: "text", text: "read it" }] }, ...readTurn("toolu_r1")]);
  assert.ok(resultText(first.payload, 2).length < CODE.length, "precondition: the first read is trimmed");
  const second = await request(env, "d1", [{ role: "user", content: [{ type: "text", text: "read it" }] }, ...readTurn("toolu_r1"), ...writeTurn]);
  assert.equal(resultText(second.payload, 2), resultText(first.payload, 2));
});

test("D2 a new read of the same path after the first left history is sent in full", async () => {
  const env = await setup();
  const first = await request(env, "d2", [{ role: "user", content: [{ type: "text", text: "read it" }] }, ...readTurn("toolu_r1")]);
  assert.ok(resultText(first.payload, 2).length < CODE.length);
  const second = await request(env, "d2", [{ role: "user", content: [{ type: "text", text: "summary, then read it again in full" }] }, ...readTurn("toolu_r2")]);
  assert.equal(resultText(second.payload, 2), CODE);
});

test("D3 a legacy snapshot without owners does not force reads untrimmed", async () => {
  const env = await setup();
  await upsertClaudeCodeSessionSnapshot(env.stateDir, "d3", { disclosedReadPaths: [PATH] });
  const out = await request(env, "d3", [{ role: "user", content: [{ type: "text", text: "read it" }] }, ...readTurn("toolu_r1")]);
  assert.ok(resultText(out.payload, 2).length < CODE.length);
});

test("D4 owners round-trip through the session snapshot", async () => {
  const env = await setup();
  await request(env, "d4", [{ role: "user", content: [{ type: "text", text: "read it" }] }, ...readTurn("toolu_r1")]);
  const snapshot = await loadClaudeCodeSessionSnapshot(env.stateDir, "d4");
  assert.deepEqual(snapshot?.disclosedReadOwners, { [PATH]: "toolu_r1" });
  await upsertClaudeCodeSessionSnapshot(env.stateDir, "d4", { requestChars: 10 });
  assert.deepEqual((await loadClaudeCodeSessionSnapshot(env.stateDir, "d4"))?.disclosedReadOwners, { [PATH]: "toolu_r1" });
});

test("D5 ownership follows the same-path read actually trimmed", async () => {
  const env = await setup();
  const first = await request(env, "d5", [
    { role: "user", content: [{ type: "text", text: "read it twice" }] },
    ...readTurnWithContent("toolu_short", "not found"),
    ...readTurn("toolu_long"),
  ]);
  const firstLongResult = resultText(first.payload, 4);

  assert.ok(firstLongResult.length < CODE.length, "precondition: only the long read is trimmed");
  assert.deepEqual(first.summary.disclosedReadOwners, { [PATH]: "toolu_long" });

  const second = await request(env, "d5", [
    { role: "user", content: [{ type: "text", text: "continue after history compaction" }] },
    ...readTurn("toolu_long"),
  ]);
  const secondLongResult = resultText(second.payload, 2);
  assert.ok(secondLongResult.length < CODE.length, "the retained long read must not expand back to full content");
  const normalizeArchiveLocation = (text: string) => text.replace(/^Archive: .+$/m, "Archive: <location>");
  assert.equal(normalizeArchiveLocation(secondLongResult), normalizeArchiveLocation(firstLongResult));
});

test("C1 the cleaner session catalog validates owners", async () => {
  const env = await setup();
  await upsertClaudeCodeSessionSnapshot(env.stateDir, "good", { disclosedReadOwners: { "/a": "toolu_1", "/b": null } });
  await upsertClaudeCodeSessionSnapshot(env.stateDir, "bad", { disclosedReadOwners: { "/a": 5 } as never });
  const listed = (await listClaudeCleanerSessions(env.stateDir)).map((session) => session.sessionId);
  assert.deepEqual(listed, ["good"]);
});
