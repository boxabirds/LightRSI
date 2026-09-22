import assert from "node:assert/strict";
import test from "node:test";
import { formatProxyInstallStatus } from "../scripts/install-codex.js";

test("installer reports a healthy proxy without deferred-start instructions", () => {
  const lines = formatProxyInstallStatus({
    running: true,
    started: true,
    pid: 4242,
    pidPath: "C:/fixture/tokenpilot-codex.pid",
    logPath: "C:/fixture/tokenpilot-codex.log",
  });
  assert.deepEqual(lines, [
    "Proxy daemon: running",
    "Proxy health: ok",
    "Proxy log: C:/fixture/tokenpilot-codex.log",
    "SessionStart hooks remain installed as an idempotent recovery path.",
  ]);
  assert.equal(lines.some((line) => line.includes("start a new Codex session")), false);
});
