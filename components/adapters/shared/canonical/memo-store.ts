/**
 * Per-session persistence for the disclosed-read memo (`ReductionMemo`).
 *
 * Stored at `<stateDir>/tokenpilot/reduction-memo/<session>.json`, so a host restart
 * (for example `opencode run --continue`) keeps knowing which read disclosed which
 * file. Loading never throws: a missing or unreadable file gives an empty memo, which
 * at worst trims one deliberate re-read of a file whose first read was compacted away.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFileAtomic } from "@lightrsi/host-adapter";
import { ReductionMemo } from "./reduction.js";

export function reductionMemoPath(stateDir: string, sessionId: string): string {
  return join(stateDir, "tokenpilot", "reduction-memo", `${encodeURIComponent(sessionId)}.json`);
}

export async function loadReductionMemo(stateDir: string, sessionId: string): Promise<ReductionMemo> {
  try {
    return ReductionMemo.fromSnapshot(JSON.parse(await readFile(reductionMemoPath(stateDir, sessionId), "utf8")));
  } catch {
    return new ReductionMemo();
  }
}

/** Write the memo if it changed since it was loaded or last saved. Returns whether it wrote. */
export async function saveReductionMemoIfDirty(stateDir: string, sessionId: string, memo: ReductionMemo): Promise<boolean> {
  if (!memo.dirty) return false;
  await writeJsonFileAtomic(reductionMemoPath(stateDir, sessionId), memo.toSnapshot());
  memo.dirty = false;
  return true;
}
