/**
 * Trusted, read-only Context Cleaner snapshots for external DSH consumers.
 *
 * DSH's live SessionStore belongs to the Cordis process.  A standalone CLI
 * must never deserialize that store or reach into its event/surface objects.
 * Instead, the running DSH adapter publishes this small, metadata-only
 * snapshot to its existing LightRSI stateDir.  External consumers can use it
 * to analyse and schedule work, but not to rewrite a DSH surface.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  ContextCleanSnapshot,
  ContextCleanTokenCountMode,
  ContextCleanerSession,
} from "@lightrsi/cleaner";
import {
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  type ContextItemKind,
  type ContextItemRef,
} from "@lightrsi/host-adapter";

import { DSH_HOST_ID } from "./snapshot.js";

export const DSH_CLEANER_SNAPSHOT_SCHEMA = "lightrsi.deepseek-harness.cleaner-snapshot/v1" as const;
export const DEFAULT_DSH_CLEANER_SNAPSHOT_MAX_AGE_MS = 5 * 60_000;

export type DshCleanerPersistedSnapshot = {
  schema: typeof DSH_CLEANER_SNAPSHOT_SCHEMA;
  hostId: typeof DSH_HOST_ID;
  sessionId: string;
  revision: string;
  capturedAt: string;
  snapshot: ContextCleanSnapshot;
};

export type DshCleanerSnapshotReadResult =
  | { outcome: "ready"; snapshot: ContextCleanSnapshot; reasons: [] }
  | { outcome: "unavailable"; reasons: string[] };

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function safeAge(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DSH_CLEANER_SNAPSHOT_MAX_AGE_MS;
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 24 * 60 * 60_000) {
    throw new Error("dsh_clean_snapshot_max_age_invalid");
  }
  return value;
}

function snapshotDirectory(stateDir: string): string {
  return join(stateDir, "cleaner-snapshot");
}

function snapshotFileName(sessionId: string): string {
  return `${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}.json`;
}

function snapshotPath(stateDir: string, sessionId: string): string {
  return join(snapshotDirectory(stateDir), snapshotFileName(sessionId));
}

const CONTEXT_ITEM_KINDS = new Set<ContextItemKind>([
  "system", "developer", "user", "assistant", "reasoning",
  "tool_call", "tool_result", "compaction", "unknown",
]);
const TOKEN_COUNT_MODES = new Set<ContextCleanTokenCountMode>([
  "exact", "estimated", "chars_only",
]);

function optionalNonBlank(value: unknown): value is string | undefined {
  return value === undefined || nonBlank(value);
}

function parseItem(value: unknown): ContextItemRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (!nonBlank(item.stableId)
    || !CONTEXT_ITEM_KINDS.has(item.kind as ContextItemKind)
    || !optionalNonBlank(item.role)
    || !optionalNonBlank(item.callId)
    || !optionalNonBlank(item.responseId)
    || !nonBlank(item.fingerprint)
    || !Number.isSafeInteger(item.chars)
    || Number(item.chars) < 0
    || (item.taskIds !== undefined && (!Array.isArray(item.taskIds)
      || !item.taskIds.every(nonBlank)
      || new Set(item.taskIds).size !== item.taskIds.length))) {
    return undefined;
  }

  return {
    stableId: item.stableId,
    kind: item.kind as ContextItemKind,
    ...(item.role === undefined ? {} : { role: item.role }),
    ...(item.callId === undefined ? {} : { callId: item.callId }),
    ...(item.responseId === undefined ? {} : { responseId: item.responseId }),
    ...(item.taskIds === undefined ? {} : { taskIds: [...item.taskIds] as string[] }),
    fingerprint: item.fingerprint,
    chars: Number(item.chars),
  };
}

function parseItemTokenCounts(value: unknown): Record<string, number> | undefined {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([stableId, count]) =>
    !nonBlank(stableId) || !Number.isSafeInteger(count) || Number(count) < 0)) return undefined;
  return Object.fromEntries(entries.map(([stableId, count]) => [stableId, Number(count)]));
}

function parsePersistedSnapshot(value: unknown): DshCleanerPersistedSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const snapshot = record.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return undefined;
  const parsed = snapshot as Record<string, unknown>;

  const items = Array.isArray(parsed.items)
    ? parsed.items.map(parseItem)
    : [];
  const itemTokenCounts = parseItemTokenCounts(parsed.itemTokenCounts);

  if (record.schema !== DSH_CLEANER_SNAPSHOT_SCHEMA
    || record.hostId !== DSH_HOST_ID
    || !nonBlank(record.sessionId)
    || !nonBlank(record.revision)
    || !canonicalTimestamp(record.capturedAt)
    || parsed.hostId !== DSH_HOST_ID
    || parsed.sessionId !== record.sessionId
    || parsed.revision !== record.revision
    || parsed.capturedAt !== record.capturedAt
    || parsed.schemaVersion !== MODEL_CONTEXT_REWRITE_SCHEMA_VERSION
    || !Array.isArray(parsed.items)
    || items.some((item) => item === undefined)
    || new Set(items.map((item) => item?.stableId)).size !== items.length
    || !TOKEN_COUNT_MODES.has(parsed.tokenCountMode as ContextCleanTokenCountMode)
    || !nonBlank(parsed.tokenCountMethod)
    || !optionalNonBlank(parsed.model)
    || itemTokenCounts === undefined) {
    return undefined;
  }

  const cleanSnapshot: ContextCleanSnapshot = {
    schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
    hostId: DSH_HOST_ID,
    sessionId: record.sessionId,
    revision: record.revision,
    capturedAt: record.capturedAt,
    items: items as ContextItemRef[],
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
    tokenCountMode: parsed.tokenCountMode as ContextCleanTokenCountMode,
    tokenCountMethod: parsed.tokenCountMethod,
    ...(parsed.itemTokenCounts === undefined ? {} : { itemTokenCounts }),
  };
  return {
    schema: DSH_CLEANER_SNAPSHOT_SCHEMA,
    hostId: DSH_HOST_ID,
    sessionId: record.sessionId,
    revision: record.revision,
    capturedAt: record.capturedAt,
    snapshot: cleanSnapshot,
  };
}

async function writeAtomically(path: string, value: DshCleanerPersistedSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await rename(temporary, path);
}

async function readSnapshotFile(path: string): Promise<DshCleanerPersistedSnapshot | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return parsePersistedSnapshot(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function isFresh(snapshot: DshCleanerPersistedSnapshot, maxAgeMs: number, now: () => number): boolean {
  const capturedAtMs = Date.parse(snapshot.capturedAt);
  const age = now() - capturedAtMs;
  // A substantially future timestamp is not a trustworthy host snapshot.
  return age >= -5_000 && age <= maxAgeMs;
}

/**
 * Write a DSH-owned snapshot.  Callers must supply data already read from the
 * live SessionStore; this function itself does not know about DSH events.
 */
export async function persistDshCleanerSnapshot(params: {
  stateDir: string;
  snapshot: ContextCleanSnapshot;
}): Promise<void> {
  const stateDir = params.stateDir.trim();
  const snapshot = params.snapshot;
  if (!stateDir || snapshot.hostId !== DSH_HOST_ID || !snapshot.sessionId.trim()
    || !snapshot.revision.trim() || !canonicalTimestamp(snapshot.capturedAt)) {
    throw new Error("dsh_clean_snapshot_write_input_invalid");
  }

  const record: DshCleanerPersistedSnapshot = {
    schema: DSH_CLEANER_SNAPSHOT_SCHEMA,
    hostId: DSH_HOST_ID,
    sessionId: snapshot.sessionId,
    revision: snapshot.revision,
    capturedAt: snapshot.capturedAt,
    snapshot,
  };
  const parsed = parsePersistedSnapshot(record);
  if (!parsed) throw new Error("dsh_clean_snapshot_write_invalid");
  await writeAtomically(snapshotPath(stateDir, snapshot.sessionId), parsed);
}

/** Read one trusted snapshot without accessing DSH's live SessionStore. */
export async function readDshCleanerSnapshot(params: {
  stateDir: string;
  sessionId: string;
  maxAgeMs?: number;
  now?: () => number;
}): Promise<DshCleanerSnapshotReadResult> {
  const stateDir = params.stateDir.trim();
  const sessionId = params.sessionId.trim();
  if (!stateDir || !sessionId) {
    return { outcome: "unavailable", reasons: ["dsh_clean_snapshot_identity_invalid"] };
  }

  const maxAgeMs = safeAge(params.maxAgeMs);
  const record = await readSnapshotFile(snapshotPath(stateDir, sessionId));
  if (!record) return { outcome: "unavailable", reasons: ["dsh_clean_snapshot_missing_or_invalid"] };
  if (record.sessionId !== sessionId) {
    return { outcome: "unavailable", reasons: ["dsh_clean_snapshot_session_mismatch"] };
  }
  if (!isFresh(record, maxAgeMs, params.now ?? Date.now)) {
    return { outcome: "unavailable", reasons: ["dsh_clean_snapshot_stale"] };
  }
  return { outcome: "ready", snapshot: record.snapshot, reasons: [] };
}

/** List only fresh, schema-valid snapshots. Invalid files are never trusted. */
export async function listDshCleanerSnapshots(params: {
  stateDir: string;
  maxAgeMs?: number;
  now?: () => number;
}): Promise<ContextCleanerSession[]> {
  const stateDir = params.stateDir.trim();
  if (!stateDir) return [];
  const maxAgeMs = safeAge(params.maxAgeMs);
  let entries: string[];
  try {
    entries = await readdir(snapshotDirectory(stateDir));
  } catch {
    return [];
  }

  const now = params.now ?? Date.now;
  const sessions = await Promise.all(entries
    .filter((entry) => typeof entry === "string" && /^[a-f0-9]{32}\.json$/u.test(entry))
    .map((entry) => readSnapshotFile(join(snapshotDirectory(stateDir), entry))));
  return sessions
    .filter((snapshot): snapshot is DshCleanerPersistedSnapshot =>
      snapshot !== undefined && isFresh(snapshot, maxAgeMs, now))
    .map((snapshot) => ({ sessionId: snapshot.sessionId, updatedAt: snapshot.capturedAt }))
    .sort((left, right) =>
      String(right.updatedAt).localeCompare(String(left.updatedAt))
      || left.sessionId.localeCompare(right.sessionId));
}
