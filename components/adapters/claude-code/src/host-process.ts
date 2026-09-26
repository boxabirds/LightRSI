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

export type HostProcessCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ stdout: string }>;

function looksLikeClaudeHost(command: string): boolean {
  // `ps -o comm=` prints the executable, which is plain `claude` for the CLI.
  // Guard against matching this adapter's own node processes or a path that
  // merely contains the word.
  const normalized = command.trim();
  if (!normalized) return false;
  const basename = normalized.split("/").pop() ?? normalized;
  return basename === "claude" || basename === "claude.exe";
}

const systemCommandRunner: HostProcessCommandRunner = async (command, args) => {
  const { stdout } = await execFileAsync(command, [...args], { windowsHide: true });
  return { stdout };
};

/** Builds the platform probe separately so the Windows path is deterministic in tests. */
export function createSystemHostProcessProbe(params?: {
  platform?: NodeJS.Platform;
  run?: HostProcessCommandRunner;
}): HostProcessProbe {
  const platform = params?.platform ?? process.platform;
  const run = params?.run ?? systemCommandRunner;
  let windowsProcessTable: Promise<Map<number, { ppid: number; command: string }>> | undefined;

  const readWindowsProcessTable = async () => {
    const script = [
      "$processInfo = Get-CimInstance Win32_Process",
      "[Console]::Out.Write(($processInfo | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress))",
    ].join("; ");
    const { stdout } = await run("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    const parsed = JSON.parse(stdout) as unknown;
    const records = Array.isArray(parsed) ? parsed : [parsed];
    const table = new Map<number, { ppid: number; command: string }>();
    for (const value of records) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const processId = record.ProcessId;
      const ppid = record.ParentProcessId;
      const command = record.Name;
      if (!Number.isSafeInteger(processId) || Number(processId) <= 0
        || !Number.isSafeInteger(ppid) || Number(ppid) < 0
        || typeof command !== "string" || !command.trim()) continue;
      table.set(Number(processId), { ppid: Number(ppid), command });
    }
    return table;
  };

  return {
    async readProcess(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
      try {
        if (platform === "win32") {
          windowsProcessTable ??= readWindowsProcessTable();
          return (await windowsProcessTable).get(pid);
        }

        const { stdout } = await run("ps", ["-o", "ppid=,comm=", "-p", String(pid)]);
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
}

/**
 * Walks up from `startPid` and returns the pid of the nearest ancestor that is
 * a Claude Code host process, or undefined when there is none, when the
 * platform offers no process table, or when the walk cannot complete.
 */
export async function resolveClaudeHostPid(params?: {
  startPid?: number;
  probe?: HostProcessProbe;
}): Promise<number | undefined> {
  const probe = params?.probe ?? createSystemHostProcessProbe();
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
