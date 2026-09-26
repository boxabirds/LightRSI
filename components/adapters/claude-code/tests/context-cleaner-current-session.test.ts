import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveCurrentClaudeCodeSessionId } from "../src/context-cleaner/current-session.js";
import { resolveClaudeHostPid, type HostProcessProbe } from "../src/host-process.js";
import { upsertClaudeCodeSessionSnapshot } from "../src/session-state.js";

/**
 * RY-03: binding the Cleaner entry point to the session the user is in.
 *
 * The process tree observed on a real machine, innermost first:
 *   54034 /bin/zsh   (the shell Claude Code ran for a skill)
 *   38153 claude     (the host that owns the session)
 *   25333 /bin/zsh   (the shell the user started Claude Code from)
 *   25292 Code Helper
 */
function probeFrom(tree: Array<{ pid: number; ppid: number; command: string }>): HostProcessProbe {
  const byPid = new Map(tree.map((entry) => [entry.pid, entry]));
  return {
    async readProcess(pid) {
      const entry = byPid.get(pid);
      return entry ? { ppid: entry.ppid, command: entry.command } : undefined;
    },
  };
}

const REAL_TREE = [
  { pid: 54034, ppid: 38153, command: "/bin/zsh" },
  { pid: 38153, ppid: 25333, command: "claude" },
  { pid: 25333, ppid: 25292, command: "/bin/zsh" },
  { pid: 25292, ppid: 25236, command: "Code Helper" },
  { pid: 25236, ppid: 1, command: "Code" },
];

async function withTempState(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-claude-current-session-"));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

test("resolveClaudeHostPid finds the nearest claude ancestor of a descendant", async () => {
  assert.equal(
    await resolveClaudeHostPid({ startPid: 54034, probe: probeFrom(REAL_TREE) }),
    38153,
  );
});

test("resolveClaudeHostPid returns undefined for a sibling started from the user's shell", async () => {
  // This is the Ctrl+Z case: the CLI is a child of 25333, the same shell that
  // started Claude Code, so walking up never reaches the host.
  const tree = [{ pid: 60001, ppid: 25333, command: "node" }, ...REAL_TREE];
  assert.equal(
    await resolveClaudeHostPid({ startPid: 60001, probe: probeFrom(tree) }),
    undefined,
  );
});

test("resolveClaudeHostPid does not mistake an adapter node process for the host", async () => {
  const tree = [
    { pid: 70001, ppid: 70002, command: "node" },
    { pid: 70002, ppid: 70003, command: "/usr/local/bin/node" },
    { pid: 70003, ppid: 1, command: "/bin/zsh" },
  ];
  assert.equal(
    await resolveClaudeHostPid({ startPid: 70001, probe: probeFrom(tree) }),
    undefined,
  );
});

test("resolveClaudeHostPid stops instead of looping on a cyclic or unreadable tree", async () => {
  const cyclic = [
    { pid: 80001, ppid: 80002, command: "node" },
    { pid: 80002, ppid: 80001, command: "node" },
  ];
  assert.equal(
    await resolveClaudeHostPid({ startPid: 80001, probe: probeFrom(cyclic) }),
    undefined,
  );
  assert.equal(
    await resolveClaudeHostPid({ startPid: 99999, probe: probeFrom(REAL_TREE) }),
    undefined,
  );
});

test("the current session is the one whose host pid matches this process tree", async () => {
  await withTempState(async (stateDir) => {
    await upsertClaudeCodeSessionSnapshot(stateDir, "session-other-window", { hostPid: 11111 });
    await upsertClaudeCodeSessionSnapshot(stateDir, "session-this-window", { hostPid: 38153 });
    // The other window wrote state most recently, so a latest-session guess
    // would pick the wrong one.
    await upsertClaudeCodeSessionSnapshot(stateDir, "session-other-window", { hostPid: 11111 });

    assert.equal(
      await resolveCurrentClaudeCodeSessionId({
        stateDir,
        startPid: 54034,
        probe: probeFrom(REAL_TREE),
      }),
      "session-this-window",
    );
  });
});

test("no session is bound when this process is not a Claude Code descendant", async () => {
  await withTempState(async (stateDir) => {
    await upsertClaudeCodeSessionSnapshot(stateDir, "session-this-window", { hostPid: 38153 });
    const tree = [{ pid: 60001, ppid: 25333, command: "node" }, ...REAL_TREE];

    assert.equal(
      await resolveCurrentClaudeCodeSessionId({
        stateDir,
        startPid: 60001,
        probe: probeFrom(tree),
      }),
      undefined,
    );
  });
});

test("no session is bound when no snapshot records this host pid", async () => {
  await withTempState(async (stateDir) => {
    await upsertClaudeCodeSessionSnapshot(stateDir, "session-without-pid", {});
    await upsertClaudeCodeSessionSnapshot(stateDir, "session-other-host", { hostPid: 11111 });

    assert.equal(
      await resolveCurrentClaudeCodeSessionId({
        stateDir,
        startPid: 54034,
        probe: probeFrom(REAL_TREE),
      }),
      undefined,
    );
  });
});
