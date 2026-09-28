/**
 * Regression matrix: recovery hints are byte-stable across requests
 *
 * Adapters re-run these passes over the whole history on every model request. The
 * hint's `Archive:` path used to carry a timestamp, so the same tool output was sent
 * with different text each time (prompt-cache miss from that point on), and
 * tool_payload_trim could name a file other than the one it wrote.
 *
 * tool_payload_trim
 *   T1 the same input reduced twice, later, gives byte-identical output
 *   T2 the hint's Archive path is the file actually written, holding the original text
 *   T3 different content under the same segment id gets a different Archive path
 * exec_output_truncation
 *   T4 the same input truncated twice, later, gives byte-identical output, and the
 *      hint's Archive path is the file written
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeTurnContext } from "@lightrsi/kernel";
import { execOutputTruncationBeforeCall } from "../src/passes/pass-exec-output-truncation.js";
import { toolPayloadTrimPass } from "../src/passes/pass-tool-payload-trim.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const archiveOf = (text: string) => /Archive: ([^\n]+)/.exec(text)?.[1];
const LOG = Array.from({ length: 2000 }, (_, i) => `[build] step ${i} compiling src/module_${i}.ts ... ok`).join("\n");

function turnCtx(workspaceDir: string, text: string, strategy: string, toolName = "bash"): RuntimeTurnContext {
  return {
    sessionId: "stability-session",
    sessionMode: "single",
    provider: "test",
    model: "test",
    prompt: "",
    budget: { maxInputTokens: 100000, reserveOutputTokens: 1000 },
    segments: [{
      id: "tool-call_1",
      kind: "volatile",
      priority: 1,
      text,
      metadata: { toolName, fieldName: "output", toolPayload: { toolName }, isToolPayload: true },
    }],
    metadata: {
      workspaceDir,
      latestUserQuery: "did the build pass",
      policy: { decisions: { reduction: { instructions: [{ strategy, segmentIds: ["tool-call_1"], parameters: { payloadKind: "stdout" } }] } } },
    },
  };
}

async function trim(workspaceDir: string, text: string): Promise<string> {
  const result = await toolPayloadTrimPass.beforeCall?.({
    turnCtx: turnCtx(workspaceDir, text, "tool_payload_trim"),
    spec: { id: "tool_payload_trim", phase: "before_call", target: "tool_payload", options: { maxChars: 1200 } },
  });
  assert.equal(result?.changed, true, "precondition: the pass trims");
  return result!.turnCtx!.segments[0]!.text;
}

async function truncate(workspaceDir: string, text: string): Promise<string> {
  const result = await execOutputTruncationBeforeCall.beforeCall?.({
    turnCtx: turnCtx(workspaceDir, text, "exec_output_truncation"),
    spec: { id: "exec_output_truncation", phase: "before_call", target: "tool_payload", options: { toolThresholds: { bash: 5000 } } },
  });
  assert.equal(result?.changed, true, "precondition: the pass truncates");
  return result!.turnCtx!.segments[0]!.text;
}

test("T1 tool_payload_trim output is byte-identical across requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stable-t1-"));
  const first = await trim(dir, LOG);
  await sleep(5);
  assert.equal(await trim(dir, LOG), first);
});

test("T2 tool_payload_trim names the file it wrote", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stable-t2-"));
  const path = archiveOf(await trim(dir, LOG));
  assert.ok(path);
  assert.equal(JSON.parse(await readFile(path, "utf8")).originalText, LOG);
});

test("T3 different content gets a different archive path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stable-t3-"));
  const a = archiveOf(await trim(dir, LOG));
  const b = archiveOf(await trim(dir, `${LOG}\nBUILD OK`));
  assert.ok(a && b);
  assert.notEqual(a, b);
});

test("T4 exec_output_truncation output is byte-identical across requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stable-t4-"));
  const first = await truncate(dir, LOG);
  await sleep(5);
  assert.equal(await truncate(dir, LOG), first);
  const path = archiveOf(first);
  assert.ok(path);
  assert.equal(JSON.parse(await readFile(path, "utf8")).originalText, LOG);
});
