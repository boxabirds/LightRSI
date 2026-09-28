/**
 * Per-session persistence for the archive-path memo (`ReductionMemo`).
 *
 * Stored at `<stateDir>/tokenpilot/reduction-memo/<session>.json` next to the
 * archives it points at. Loading never throws: a missing or unreadable file gives an
 * empty memo, which only costs one prefix-cache miss.
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
