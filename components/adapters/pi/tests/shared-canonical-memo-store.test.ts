/**
 * Regression matrix: adapters/shared/canonical/memo-store.ts + ReductionMemo persistence
 *
 * ReductionMemo snapshot
 *   MS1 round trip keeps Archive-line reuse and disclosed-path ownership (owned + unattributed)
 *   MS2 fromSnapshot never throws on junk (null, string, wrong version, bad entries);
 *       valid entries survive, invalid ones are dropped; the result is not dirty
 *   MS3 bounded at REDUCTION_MEMO_MAX_SEGMENTS: the oldest entry goes first; updating an
 *       entry refreshes its recency
 *   MS4 dirty flag: set by a new/changed output or a new disclosed path; not set by an
 *       identical output, an Archive-only reuse or a known path; cleared by clear()
 * memo-store
 *   MS5 load: missing file or corrupt JSON → empty memo, no throw
 *   MS6 save: clean memo → no write; dirty memo → written under
 *       <stateDir>/tokenpilot/reduction-memo/, dirty cleared, reload equivalent;
 *       session ids are encoded (no path traversal)
 *   MS7 end to end: reduce → save → load into a fresh memo (host restart) → the same
 *       request is byte-identical; control: a fresh memo without the load differs
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { configureStatePathResolver } from "@lightrsi/artifact-store";
import { createStaticStatePathResolver } from "@lightrsi/host-adapter";
import type { RuntimeMessage } from "@lightrsi/kernel";

import { createCanonicalEnvelope } from "../../shared/canonical/before-call.js";
import { normalizeCanonicalAdapterConfig } from "../../shared/canonical/config.js";
import { loadReductionMemo, reductionMemoPath, saveReductionMemoIfDirty } from "../../shared/canonical/memo-store.js";
import { REDUCTION_MEMO_MAX_SEGMENTS, ReductionMemo, reduceCanonicalEnvelope } from "../../shared/canonical/reduction.js";

let stateDir = "";
before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "tp-memo-"));
  configureStatePathResolver(createStaticStatePathResolver({ hostId: "pi", displayName: "pi", stateDir, namespaceDir: "tokenpilot" }));
});

const withArchive = (body: string, path: string) => `${body}\nArchive: ${path}`;
const seg = (id: string, path?: string) => ({ id, kind: "volatile", text: "x", priority: 0, metadata: path ? { path } : {} }) as never;

describe("ReductionMemo snapshot", () => {
  it("MS1 a round trip keeps Archive reuse and disclosure ownership", () => {
    const memo = new ReductionMemo();
    memo.settle("tool-1", "orig", withArchive("body", "/1.json"));
    memo.recordDisclosedReadPaths(["/repo/a.ts", "/repo/b.ts"], [seg("tool-1", "/repo/a.ts")]);
    const restored = ReductionMemo.fromSnapshot(JSON.parse(JSON.stringify(memo.toSnapshot())));
    assert.deepEqual(restored.settle("tool-1", "orig", withArchive("body", "/2.json")), { text: withArchive("body", "/1.json"), reused: true });
    assert.deepEqual(restored.disclosedReadPaths, ["/repo/a.ts", "/repo/b.ts"]);
    assert.deepEqual(restored.carriedDisclosedReadPaths(new Set(["tool-1"])), ["/repo/b.ts"]);
    assert.deepEqual(restored.carriedDisclosedReadPaths(new Set()), ["/repo/a.ts", "/repo/b.ts"]);
  });

  it("MS2 junk snapshots never throw and keep only valid entries", () => {
    for (const junk of [null, undefined, "x", 3, [], { version: 2, segments: [["k", "t"]] }, { version: 1, segments: "nope", disclosed: 5 }]) {
      const memo = ReductionMemo.fromSnapshot(junk);
      assert.equal(memo.size, 0);
      assert.equal(memo.disclosedReadPaths, undefined);
      assert.equal(memo.dirty, false);
    }
    const mixed = ReductionMemo.fromSnapshot({
      version: 1,
      segments: [["good", "text"], ["bad"], [1, "x"], "str", ["also", 2]],
      disclosed: [["/Ok", "tool-1"], ["/unowned", null], [7, "x"], "str", ["", "tool-2"]],
    });
    assert.equal(mixed.size, 1);
    assert.deepEqual(mixed.disclosedReadPaths, ["/ok", "/unowned"]);
    assert.equal(mixed.dirty, false);
  });

  it("MS3 the memo is bounded and evicts the oldest entry first", () => {
    const memo = new ReductionMemo();
    for (let i = 0; i < REDUCTION_MEMO_MAX_SEGMENTS; i += 1) memo.settle(`s${i}`, "o", `t${i}`);
    memo.settle("s0", "o", "t0-updated");
    memo.settle("extra", "o", "t");
    assert.equal(memo.size, REDUCTION_MEMO_MAX_SEGMENTS);
    const keys = memo.toSnapshot().segments.map(([key]) => key.split("\u0000")[0]);
    assert.ok(!keys.includes("s1"), "the oldest untouched entry is dropped");
    assert.ok(keys.includes("s0"), "an updated entry is kept");
    assert.equal(keys.at(-1), "extra");
  });

  it("MS4 the dirty flag tracks real changes only", () => {
    const memo = new ReductionMemo();
    assert.equal(memo.dirty, false);
    memo.settle("s", "o", withArchive("b", "/1"));
    assert.equal(memo.dirty, true);
    memo.dirty = false;
    memo.settle("s", "o", withArchive("b", "/1"));
    assert.equal(memo.dirty, false, "identical output");
    memo.settle("s", "o", withArchive("b", "/2"));
    assert.equal(memo.dirty, false, "Archive-only reuse");
    memo.settle("s", "o", withArchive("changed", "/3"));
    assert.equal(memo.dirty, true, "changed output");
    memo.dirty = false;
    memo.recordDisclosedReadPaths(["/a"], []);
    assert.equal(memo.dirty, true, "new path");
    memo.dirty = false;
    memo.recordDisclosedReadPaths(["/A "], []);
    assert.equal(memo.dirty, false, "known path");
    memo.clear();
    assert.equal(memo.dirty, false);
  });
});

describe("memo-store", () => {
  it("MS5 a missing or corrupt file loads as an empty memo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-memo-load-"));
    assert.equal((await loadReductionMemo(dir, "none")).size, 0);
    await mkdir(dirname(reductionMemoPath(dir, "bad")), { recursive: true });
    await writeFile(reductionMemoPath(dir, "bad"), "{not json");
    const memo = await loadReductionMemo(dir, "bad");
    assert.equal(memo.size, 0);
    assert.equal(memo.dirty, false);
  });

  it("MS6 only dirty memos are written, under an encoded session file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-memo-save-"));
    const clean = new ReductionMemo();
    assert.equal(await saveReductionMemoIfDirty(dir, "s", clean), false);
    assert.equal(existsSync(reductionMemoPath(dir, "s")), false);

    const memo = new ReductionMemo();
    memo.settle("tool-1", "orig", withArchive("body", "/1.json"));
    memo.recordDisclosedReadPaths(["/repo/a.ts"], [seg("tool-1", "/repo/a.ts")]);
    const sessionId = "../escape/ses 1";
    assert.equal(await saveReductionMemoIfDirty(dir, sessionId, memo), true);
    assert.equal(memo.dirty, false);
    assert.equal(dirname(reductionMemoPath(dir, sessionId)), join(dir, "tokenpilot", "reduction-memo"));
    assert.deepEqual(await readdir(join(dir, "tokenpilot", "reduction-memo")), [`${encodeURIComponent(sessionId)}.json`]);
    const loaded = await loadReductionMemo(dir, sessionId);
    assert.deepEqual(loaded.toSnapshot(), memo.toSnapshot());
    assert.equal(await saveReductionMemoIfDirty(dir, sessionId, memo), false, "unchanged memo is not rewritten");
  });

  it("MS7 a restarted host sends byte-identical history once the memo is reloaded", async () => {
    const BIG = Array.from({ length: 3000 }, (_, i) => `line ${i} output from build step ok`).join("\n");
    const messages: RuntimeMessage[] = [
      { role: "user", content: [{ type: "text", text: "build" }] },
      { role: "assistant", content: [{ type: "tool_call", toolCallId: "c1", toolName: "bash", argumentsJson: { command: "make" } }] },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "c1", toolName: "bash", status: "success", text: BIG }] },
    ];
    const envelope = createCanonicalEnvelope({ hostId: "pi", displayName: "pi", sessionId: "ms7", model: "m", messages });
    const config = normalizeCanonicalAdapterConfig({}, { defaultStateDir: stateDir });
    const text = (env: typeof envelope) => JSON.stringify(env.messages[2]);

    const first = new ReductionMemo();
    const a = await reduceCanonicalEnvelope({ envelope, config, memo: first });
    await saveReductionMemoIfDirty(stateDir, "ms7", first);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const restarted = await loadReductionMemo(stateDir, "ms7");
    const b = await reduceCanonicalEnvelope({ envelope, config, memo: restarted });
    assert.equal(text(b.envelope), text(a.envelope));

    await new Promise((resolve) => setTimeout(resolve, 5));
    const control = await reduceCanonicalEnvelope({ envelope, config, memo: new ReductionMemo() });
    assert.notEqual(text(control.envelope), text(a.envelope), "control: without the reloaded memo the Archive line changes");
  });
});
