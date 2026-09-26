import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Claude Code publishes no environment channel for the live session: the
 * processes it spawns are detached from the controlling terminal and carry no
 * session id. What they do keep is the process tree — a command Claude Code
 * runs for a skill is a descendant of the `claude` process that owns the
 * session, so the nearest `claude` ancestor identifies the session uniquely.
 *
 * The Cleaner hook records its own `claude` ancestor next to the session id;
 * a CLI started by that same Claude Code resolves the same pid and binds to
 * exactly that session instead of guessing the most recent one.
 *
 * This only holds for descendants. A CLI the user starts from their shell
 * after suspending Claude Code is its sibling, not its child, and resolves to
 * undefined — that path carries an explicit --session instead.
 */

const MAX_ANCESTOR_DEPTH = 24;

export type HostProcessProbe = {
  /** Returns `<ppid> <command>` for one pid, or undefined when it cannot be read. */
  readProcess(pid: number): Promise<{ ppid: number; command: string } | undefined>;
};

function looksLikeClaudeHost(command: string): boolean {
  // `ps -o comm=` prints the executable, which is plain `claude` for the CLI.
  // Guard against matching this adapter's own node processes or a path that
  // merely contains the word.
  const normalized = command.trim();
  if (!normalized) return false;
  const basename = normalized.split("/").pop() ?? normalized;
  return basename === "claude" || basename === "claude.exe";
}

const defaultProbe: HostProcessProbe = {
  async readProcess(pid) {
    if (process.platform === "win32") return undefined;
    try {
      const { stdout } = await execFileAsync("ps", ["-o", "ppid=,comm=", "-p", String(pid)]);
      const line = stdout.trim();
      if (!line) return undefined;
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match) return undefined;
      return { ppid: Number.parseInt(match[1]!, 10), command: match[2]! };
    } catch {
      return undefined;
    }
  },
};

/**
 * Walks up from `startPid` and returns the pid of the nearest ancestor that is
 * a Claude Code host process, or undefined when there is none, when the
 * platform offers no process table, or when the walk cannot complete.
 */
export async function resolveClaudeHostPid(params?: {
  startPid?: number;
  probe?: HostProcessProbe;
}): Promise<number | undefined> {
  const probe = params?.probe ?? defaultProbe;
  let pid = params?.startPid ?? process.pid;
  const visited = new Set<number>();
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    if (!Number.isSafeInteger(pid) || pid <= 1 || visited.has(pid)) return undefined;
    visited.add(pid);
    const entry = await probe.readProcess(pid);
    if (!entry) return undefined;
    if (looksLikeClaudeHost(entry.command)) return pid;
    pid = entry.ppid;
  }
  return undefined;
}
