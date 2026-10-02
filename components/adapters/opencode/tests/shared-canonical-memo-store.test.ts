/**
 * Regression matrix: adapters/shared/canonical/memo-store.ts + ReductionMemo persistence
 *
 * ReductionMemo snapshot
 *   MS1 round trip keeps every disclosed path and its owner (owned and unattributable)
 *   MS2 fromSnapshot never throws on junk (null, string, wrong or old version, bad
 *       entries); valid entries survive, invalid ones are dropped; never dirty
 * memo-store
 *   MS3 load: missing file or corrupt JSON → empty memo, no throw
 *   MS4 save: clean memo → no write; dirty memo → written under
 *       <stateDir>/tokenpilot/reduction-memo/, dirty cleared, reload equivalent;
 *       session ids are encoded (no path traversal)
 *   MS5 end to end: after a host restart the reloaded memo still knows the
 *       disclosure, so a deliberate re-read (first read compacted away) is sent in
 *       full; control: a fresh memo without the load trims it
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
import { ReductionMemo, reduceCanonicalEnvelope } from "../../shared/canonical/reduction.js";

let stateDir = "";
before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "tp-memo-"));
  configureStatePathResolver(createStaticStatePathResolver({ hostId: "opencode", displayName: "OpenCode", stateDir, namespaceDir: "tokenpilot" }));
});

const seg = (id: string, path?: string) => ({ id, kind: "volatile", text: "x", priority: 0, metadata: path ? { path } : {} }) as never;

describe("ReductionMemo snapshot", () => {
  it("MS1 a round trip keeps paths and owners", () => {
    const memo = new ReductionMemo();
    memo.recordDisclosedReadPaths(["/repo/a.ts", "/repo/b.ts"], [seg("tool-1", "/repo/a.ts")], new Set(["tool-1"]));
    const restored = ReductionMemo.fromSnapshot(JSON.parse(JSON.stringify(memo.toSnapshot())));
    assert.deepEqual(restored.disclosedReadPaths, ["/repo/a.ts", "/repo/b.ts"]);
    assert.deepEqual(restored.carriedDisclosedReadPaths(new Set(["tool-1"])), ["/repo/b.ts"]);
    assert.deepEqual(restored.carriedDisclosedReadPaths(new Set()), ["/repo/a.ts", "/repo/b.ts"]);
    assert.equal(restored.dirty, false);
  });

  it("MS2 junk snapshots never throw and keep only valid entries", () => {
    for (const junk of [null, undefined, "x", 3, [], { version: 1, disclosed: [["/a", "t1"]] }, { version: 2, disclosed: "nope" }]) {
      const memo = ReductionMemo.fromSnapshot(junk);
      assert.equal(memo.disclosedReadPaths, undefined);
      assert.equal(memo.dirty, false);
    }
    const mixed = ReductionMemo.fromSnapshot({
      version: 2,
      disclosed: [["/Ok", "tool-1"], ["/unowned", null], [7, "x"], "str", ["", "tool-2"]],
    });
    assert.deepEqual(mixed.disclosedReadPaths, ["/ok", "/unowned"]);
    assert.deepEqual(mixed.carriedDisclosedReadPaths(new Set(["tool-1"])), ["/unowned"]);
    assert.equal(mixed.dirty, false);
  });
});

describe("memo-store", () => {
  it("MS3 a missing or corrupt file loads as an empty memo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-memo-load-"));
    assert.equal((await loadReductionMemo(dir, "none")).disclosedReadPaths, undefined);
    await mkdir(dirname(reductionMemoPath(dir, "bad")), { recursive: true });
    await writeFile(reductionMemoPath(dir, "bad"), "{not json");
    const memo = await loadReductionMemo(dir, "bad");
    assert.equal(memo.disclosedReadPaths, undefined);
    assert.equal(memo.dirty, false);
  });

  it("MS4 only dirty memos are written, under an encoded session file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-memo-save-"));
    assert.equal(await saveReductionMemoIfDirty(dir, "s", new ReductionMemo()), false);
    assert.equal(existsSync(reductionMemoPath(dir, "s")), false);

    const memo = new ReductionMemo();
    memo.recordDisclosedReadPaths(["/repo/a.ts"], [seg("tool-1", "/repo/a.ts")], new Set(["tool-1"]));
    const sessionId = "../escape/ses 1";
    assert.equal(await saveReductionMemoIfDirty(dir, sessionId, memo), true);
    assert.equal(memo.dirty, false);
    assert.equal(dirname(reductionMemoPath(dir, sessionId)), join(dir, "tokenpilot", "reduction-memo"));
    assert.deepEqual(await readdir(join(dir, "tokenpilot", "reduction-memo")), [`${encodeURIComponent(sessionId)}.json`]);
    assert.deepEqual((await loadReductionMemo(dir, sessionId)).toSnapshot(), memo.toSnapshot());
    assert.equal(await saveReductionMemoIfDirty(dir, sessionId, memo), false, "an unchanged memo is not rewritten");
  });

  it("MS5 a restarted host still honours a deliberate re-read", async () => {
    const CODE = Array.from({ length: 400 }, (_, i) => `export function handler${i}(input: string): string {\n  return input.trim() + "${i}";\n}\n`).join("\n");
    const PATH = "/repo/src/handlers.ts";
    const user = (text: string): RuntimeMessage => ({ role: "user", content: [{ type: "text", text }] });
    const read = (callId: string): RuntimeMessage[] => [
      { role: "assistant", content: [{ type: "tool_call", toolCallId: callId, toolName: "read", argumentsJson: { path: PATH } }] },
      { role: "tool", content: [{ type: "tool_result", toolCallId: callId, toolName: "read", status: "success", text: CODE }] },
    ];
    const config = normalizeCanonicalAdapterConfig({}, { defaultStateDir: stateDir });
    const env = (messages: RuntimeMessage[]) => createCanonicalEnvelope({ hostId: "opencode", displayName: "OpenCode", sessionId: "ms5", model: "m", messages });
    const textAt = (envelope: ReturnType<typeof env>, index: number) => {
      const block = (envelope.messages[index]?.content as Array<{ text?: string }>)[0];
      return block?.text ?? "";
    };

    const before = new ReductionMemo();
    const first = await reduceCanonicalEnvelope({ envelope: env([user("read it"), ...read("r1")]), config, memo: before });
    assert.ok(textAt(first.envelope, 2).length < CODE.length, "precondition: the first read is trimmed");
    await saveReductionMemoIfDirty(stateDir, "ms5", before);

    const compacted = [user("summary of earlier work"), user("read it again in full"), ...read("r2")];
    const restarted = await loadReductionMemo(stateDir, "ms5");
    const reread = await reduceCanonicalEnvelope({ envelope: env(compacted), config, memo: restarted });
    assert.equal(textAt(reread.envelope, 3), CODE, "the reloaded memo marks the re-read as a repeat");

    const control = await reduceCanonicalEnvelope({ envelope: env(compacted), config, memo: new ReductionMemo() });
    assert.ok(textAt(control.envelope, 3).length < CODE.length, "control: without the reload the re-read is trimmed");
  });
});
