import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

const LOCK_RECOVERY_GRACE_MS = 1_000;
const RECOVERY_ELECTION_MS = 25;

type LockOwner = {
  pid: number;
  createdAt: string;
  ownerId: string;
};

function createOwner(): LockOwner {
  return { pid: process.pid, createdAt: new Date().toISOString(), ownerId: randomUUID() };
}

function processIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function isRecoverable(path: string): Promise<boolean> {
  let ageMs: number;
  try {
    ageMs = Date.now() - (await stat(path)).mtimeMs;
  } catch { return false; }
  if (ageMs < LOCK_RECOVERY_GRACE_MS) return false;
  try {
    const owner = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    return typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0
      && processIsDead(owner.pid);
  } catch { return false; }
}

async function acquireOwned(path: string, owner: LockOwner): Promise<FileHandle> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(JSON.stringify(owner));
    return handle;
  } catch (error) {
    await handle.close();
    await unlink(path).catch(() => undefined);
    throw error;
  }
}

async function releaseOwned(path: string, handle: FileHandle, ownerId: string): Promise<void> {
  await handle.close();
  try {
    const current = JSON.parse(await readFile(path, "utf8")) as { ownerId?: unknown };
    if (current.ownerId === ownerId) await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function acquireRecoveryGuard(path: string, owner: LockOwner): Promise<FileHandle> {
  try {
    return await acquireOwned(path, owner);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !await isRecoverable(path)) {
      throw error;
    }
    await unlink(path);
    return acquireOwned(path, owner);
  }
}

type RecoveryCandidate = {
  owner: LockOwner;
  path: string;
};

type RecoveryCandidateRecord = LockOwner & {
  choosing: boolean;
  ticket?: number;
};

async function publishRecoveryCandidate(path: string, record: RecoveryCandidateRecord): Promise<void> {
  // Readers must see a complete record, including while a choosing candidate
  // publishes its ticket. In-place writes expose empty/partial JSON to peers.
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(record), { flag: "wx" });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function createRecoveryCandidate(lockPath: string): Promise<RecoveryCandidate> {
  const owner = createOwner();
  const directory = `${lockPath}.reclaimers`;
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${owner.pid}-${owner.ownerId}.json`);
  try {
    await publishRecoveryCandidate(path, { ...owner, choosing: true });
  } catch (error) {
    await unlink(path).catch(() => undefined);
    throw error;
  }
  return { owner, path };
}

async function readRecoveryCandidates(candidate: RecoveryCandidate): Promise<Array<{
  path: string;
  record: RecoveryCandidateRecord;
}> | undefined> {
  const directory = dirname(candidate.path);
  const contenders: Array<{ path: string; record: RecoveryCandidateRecord }> = [];
  for (const name of await readdir(directory)) {
    const match = /^(\d+)-([0-9a-f-]+)\.json$/i.exec(name);
    if (!match) continue;
    const path = join(directory, name);
    let details;
    try { details = await stat(path, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return undefined;
    }
    const pid = Number(match[1]);
    const ageMs = Date.now() - Number(details.mtimeMs);
    if (Number.isSafeInteger(pid) && pid > 0 && processIsDead(pid)
      && ageMs >= LOCK_RECOVERY_GRACE_MS) {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      continue;
    }
    try {
      const record = JSON.parse(await readFile(path, "utf8")) as Partial<RecoveryCandidateRecord>;
      const validTicket = record.choosing === true || (record.choosing === false
        && typeof record.ticket === "number" && Number.isSafeInteger(record.ticket)
        && record.ticket > 0);
      if (record.pid !== pid || record.ownerId !== match[2]
        || typeof record.createdAt !== "string" || !validTicket) return undefined;
      contenders.push({ path, record: record as RecoveryCandidateRecord });
    } catch (error) {
      // A losing contender may finish cleanup after stat but before readFile.
      // Its disappearance does not invalidate the remaining candidates.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return undefined;
    }
  }
  return contenders;
}

async function isRecoveryWinner(candidate: RecoveryCandidate): Promise<boolean> {
  const initial = await readRecoveryCandidates(candidate);
  if (!initial) return false;
  const ticket = initial.reduce((maximum, contender) => contender.record.choosing
    ? maximum : Math.max(maximum, contender.record.ticket ?? 0), 0) + 1;
  await publishRecoveryCandidate(candidate.path, {
    ...candidate.owner,
    choosing: false,
    ticket,
  });
  await new Promise((resolve) => setTimeout(resolve, RECOVERY_ELECTION_MS));
  const contenders = await readRecoveryCandidates(candidate);
  if (!contenders || contenders.some((contender) => contender.record.choosing)) return false;
  contenders.sort((left, right) => (left.record.ticket ?? 0) - (right.record.ticket ?? 0)
    || left.record.ownerId.localeCompare(right.record.ownerId)
    || left.path.localeCompare(right.path));
  return contenders[0]?.path === candidate.path;
}

/** Shared by OpenClaw commands and all canonical state writers. */
export async function withOpenClawCleanerSessionLock<T>(params: {
  stateDir: string;
  sessionId: string;
  action(): Promise<T>;
}): Promise<T> {
  const key = createHash("sha256").update(params.sessionId).digest("hex");
  const path = join(params.stateDir, "context-cleaner", "openclaw-locks", `${key}.lock`);
  await mkdir(dirname(path), { recursive: true });
  const owner = createOwner();
  let handle: FileHandle | undefined;
  let legacyRecoveryHandle: FileHandle | undefined;
  let recovery: RecoveryCandidate | undefined;
  try {
    try {
      handle = await acquireOwned(path, owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        // Unique candidates stay present through the action. A stable ticket
        // order selects the only process allowed to replace a dead main lock.
        recovery = await createRecoveryCandidate(path);
        if (!await isRecoveryWinner(recovery)) throw new Error("openclaw_clean_session_busy");
        const legacyRecoveryPath = `${path}.reclaim`;
        // Hold the old-format guard as a bridge so an older client cannot
        // recover the same main lock while this version owns it.
        legacyRecoveryHandle = await acquireRecoveryGuard(legacyRecoveryPath, owner);
        // Never expire a live owner's lock, even for a long model/archive call.
        if (!await isRecoverable(path)) throw new Error("openclaw_clean_session_busy");
        await unlink(path).catch((unlinkError: NodeJS.ErrnoException) => {
          if (unlinkError.code !== "ENOENT") throw unlinkError;
        });
        handle = await acquireOwned(path, owner);
      } catch {
        throw new Error("openclaw_clean_session_busy");
      }
    }
    return await params.action();
  } finally {
    if (handle) await releaseOwned(path, handle, owner.ownerId);
    if (legacyRecoveryHandle) {
      await releaseOwned(`${path}.reclaim`, legacyRecoveryHandle, owner.ownerId);
    }
    if (recovery) await unlink(recovery.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
