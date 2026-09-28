/**
 * Regression matrix: content-derived archive locations (src/archive-recovery/index.ts)
 *
 * Adapters re-reduce the full history on every request. A timestamped archive name
 * changed the recovery hint every time (breaking prompt caching), wrote a new file
 * every time, and could differ from the file actually written.
 *
 * buildArchiveLocation
 *   A1 with originalText: the same (session, segment, text) → the same path, however
 *      much time passes
 *   A2 with originalText: different text, segment or session → a different path
 *   A3 without originalText → the previous timestamped name (backward compatible)
 *   A4 unsafe segment ids are sanitized in the file name (no path traversal)
 * archiveContent
 *   A5 returns the path it wrote, which equals buildArchiveLocation for the same inputs;
 *      archiving the same content twice leaves one file and the dataKey still resolves
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { archiveContent, buildArchiveLocation } from "../src/index.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("A1 the same content always maps to the same path", async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), "archive-a1-"));
  const params = { sessionId: "s", segmentId: "tool-1", archiveDir, originalText: "body" };
  const first = buildArchiveLocation(params);
  await sleep(5);
  assert.deepEqual(buildArchiveLocation(params), first);
  assert.equal(dirname(first.archivePath), archiveDir);
});

test("A2 different text, segment or session gives a different path", () => {
  const base = { sessionId: "s", segmentId: "tool-1", originalText: "body", workspaceDir: "/w" };
  const path = buildArchiveLocation(base).archivePath;
  assert.notEqual(buildArchiveLocation({ ...base, originalText: "body2" }).archivePath, path);
  assert.notEqual(buildArchiveLocation({ ...base, segmentId: "tool-2" }).archivePath, path);
  assert.notEqual(buildArchiveLocation({ ...base, sessionId: "s2" }).archivePath, path);
});

test("A3 without originalText the name stays timestamped", () => {
  const before = Date.now();
  const name = basename(buildArchiveLocation({ sessionId: "s", segmentId: "tool-1", archiveDir: "/a" }).archivePath);
  const match = /^(\d+)-tool-1\.json$/.exec(name);
  assert.ok(match, name);
  assert.ok(Number(match[1]) >= before);
});

test("A4 unsafe segment ids are sanitized", () => {
  const { archivePath, archiveDir } = buildArchiveLocation({ sessionId: "s", segmentId: "../../etc/passwd", archiveDir: "/a", originalText: "x" });
  assert.equal(dirname(archivePath), archiveDir);
  assert.ok(!basename(archivePath).includes("/"));
});

test("A5 archiveContent writes where the location says, once per content", async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), "archive-a5-"));
  const params = { sessionId: "s", segmentId: "tool-1", sourcePass: "tool_payload_trim", toolName: "read", dataKey: "/repo/a.ts", originalText: "full body", archiveDir };
  const first = await archiveContent(params);
  await sleep(5);
  const second = await archiveContent(params);
  assert.equal(second.archivePath, first.archivePath);
  assert.equal(first.archivePath, buildArchiveLocation(params).archivePath);
  const files = (await readdir(archiveDir)).filter((name) => name.endsWith(".json") && name !== "key-lookup.json");
  assert.deepEqual(files, [basename(first.archivePath)]);
  assert.equal(JSON.parse(await readFile(first.archivePath, "utf8")).originalText, "full body");
  const lookup = JSON.parse(await readFile(join(archiveDir, "key-lookup.json"), "utf8")) as Record<string, string>;
  assert.equal(lookup["/repo/a.ts"], first.archivePath);
});
