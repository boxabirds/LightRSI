import { listClaudeCleanerSessions } from "./session-catalog.js";
import { resolveClaudeHostPid, type HostProcessProbe } from "../host-process.js";
import { loadClaudeCodeSessionSnapshot } from "../session-state.js";

/**
 * Resolves the Claude Code session this process belongs to, or undefined.
 *
 * A command Claude Code runs for a skill is a descendant of the `claude`
 * process that owns the session, and the hook records that pid on the session
 * snapshot, so the two meet at a pid nobody had to guess. Returning undefined
 * is the correct answer whenever that chain does not hold — most importantly
 * for a CLI the user starts from their own shell after suspending Claude Code,
 * which is the host's sibling rather than its descendant. Callers must refuse
 * or ask for an explicit session then, never fall back to the most recent one.
 */
export async function resolveCurrentClaudeCodeSessionId(params: {
  stateDir: string;
  startPid?: number;
  probe?: HostProcessProbe;
}): Promise<string | undefined> {
  const stateDir = params.stateDir.trim();
  if (!stateDir) return undefined;

  const hostPid = await resolveClaudeHostPid({
    startPid: params.startPid,
    probe: params.probe,
  });
  if (hostPid === undefined) return undefined;

  // listClaudeCleanerSessions is newest-first, so the first match is the live
  // session for this host process even if an older one reused the pid.
  const sessions = await listClaudeCleanerSessions(stateDir);
  for (const session of sessions) {
    const snapshot = await loadClaudeCodeSessionSnapshot(stateDir, session.sessionId);
    if (snapshot?.hostPid === hostPid) return session.sessionId;
  }
  return undefined;
}
