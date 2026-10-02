/**
 * Regression matrix: adapters/shared/canonical/logger.ts
 *
 * failOpen(logger, hook, body, fallback)
 *   F1 body returns synchronously → value, nothing logged
 *   F2 body resolves               → value, nothing logged
 *   F3 body throws synchronously   → fallback, one warn naming the hook
 *   F4 body rejects                → fallback, one warn naming the hook
 * createFileLogger
 *   L1 info/warn append a line with timestamp, level, host id and detail
 *   L2 debug writes only when debug() is true
 *   L3 no stateDir → no write, no throw
 *   L4 unwritable stateDir → no throw
 *   L5 Error details render as "Name: message"
 * adapterLogPath
 *   P1 <stateDir>/tokenpilot/adapter.log
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { adapterLogPath, createFileLogger, failOpen, type AdapterLogger } from "../../shared/canonical/logger.js";

function recordingLogger(): AdapterLogger & { warns: Array<[string, unknown]> } {
  const warns: Array<[string, unknown]> = [];
  return { warns, info() {}, debug() {}, warn(message, detail) { warns.push([message, detail]); } };
}

describe("failOpen", () => {
  it("F1 a synchronous value passes through", async () => {
    const log = recordingLogger();
    assert.equal(await failOpen(log, "h", () => 1, 0), 1);
    assert.equal(log.warns.length, 0);
  });
  it("F2 a resolved value passes through", async () => {
    const log = recordingLogger();
    assert.equal(await failOpen(log, "h", async () => 2, 0), 2);
    assert.equal(log.warns.length, 0);
  });
  it("F3 a synchronous throw returns the fallback and warns", async () => {
    const log = recordingLogger();
    assert.equal(await failOpen(log, "context", () => { throw new Error("x"); }, "fb"), "fb");
    assert.deepEqual(log.warns.map(([m]) => m), ["context failed open"]);
  });
  it("F4 a rejection returns the fallback and warns", async () => {
    const log = recordingLogger();
    assert.equal(await failOpen(log, "turn_end", () => Promise.reject(new Error("y")), undefined), undefined);
    assert.deepEqual(log.warns.map(([m]) => m), ["turn_end failed open"]);
  });
});

describe("createFileLogger", () => {
  it("L1 info and warn append formatted lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-log-"));
    const logger = createFileLogger({ hostId: "opencode", stateDir: () => dir, debug: () => false });
    logger.info("hello", { a: 1 });
    logger.warn("careful");
    const lines = (await readFile(adapterLogPath(dir), "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^\d{4}-\d{2}-\d{2}T\S+ info \[opencode\] hello \{"a":1\}$/);
    assert.match(lines[1]!, / warn \[opencode\] careful$/);
  });
  it("L2 debug writes only when enabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-log-"));
    let debug = false;
    const logger = createFileLogger({ hostId: "opencode", stateDir: () => dir, debug: () => debug });
    logger.debug("hidden");
    assert.equal(existsSync(adapterLogPath(dir)), false);
    debug = true;
    logger.debug("shown");
    assert.match(await readFile(adapterLogPath(dir), "utf8"), /debug \[opencode\] shown/);
  });
  it("L3 no stateDir writes nothing and does not throw", () => {
    const logger = createFileLogger({ hostId: "opencode", stateDir: () => undefined, debug: () => true });
    assert.doesNotThrow(() => logger.warn("x"));
  });
  it("L4 an unwritable stateDir does not throw", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-log-"));
    const blocker = join(dir, "file");
    await writeFile(blocker, "x");
    const logger = createFileLogger({ hostId: "opencode", stateDir: () => blocker, debug: () => true });
    assert.doesNotThrow(() => logger.warn("x"));
  });
  it("L5 errors render as name and message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-log-"));
    const logger = createFileLogger({ hostId: "opencode", stateDir: () => dir, debug: () => false });
    logger.warn("failed", new TypeError("bad input"));
    assert.match(await readFile(adapterLogPath(dir), "utf8"), /failed TypeError: bad input/);
  });
});

describe("adapterLogPath", () => {
  it("P1 lives under the namespace dir", () => {
    assert.equal(adapterLogPath("/s"), join("/s", "tokenpilot", "adapter.log"));
  });
});
