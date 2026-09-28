import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import type { ContextCleanerSession } from "@lightrsi/cleaner";
import { sessionStateRoot } from "@lightrsi/host-adapter";

import { loadClaudeCodeSessionSnapshot } from "../session-state.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalCount(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function validSessionState(value: unknown, sessionId: string): value is {
  sessionId: string;
  updatedAt: string;
} {
  return isRecord(value)
    && value.sessionId === sessionId
    && canonicalTimestamp(value.updatedAt)
    && optionalString(value.latestResponseId)
    && optionalString(value.previousResponseId)
    && optionalString(value.latestModel)
    && optionalString(value.workspaceHint)
    && optionalString(value.lastHookEvent)
    && optionalCount(value.hostPid)
    && optionalString(value.lastToolName)
    && (value.disclosedReadPaths === undefined
      || (Array.isArray(value.disclosedReadPaths)
        && value.disclosedReadPaths.every((path) => typeof path === "string")))
    && (value.disclosedReadOwners === undefined
      || (isRecord(value.disclosedReadOwners)
        && Object.values(value.disclosedReadOwners).every((owner) => owner === null || typeof owner === "string")))
    && optionalCount(value.lastToolInputChars)
    && optionalCount(value.lastToolOutputChars)
    && optionalCount(value.requestChars)
    && optionalCount(value.responseChars)
    && optionalCount(value.assistantChars)
    && optionalCount(value.reductionSavedChars)
    && optionalCount(value.evictionSavedChars);
}

export async function listClaudeCleanerSessions(
  stateDir: string,
): Promise<ContextCleanerSession[]> {
  const directory = join(sessionStateRoot(stateDir), "sessions");
  let names: string[];
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const sessions = await Promise.all(names.map(async (name): Promise<ContextCleanerSession | undefined> => {
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(basename(name, ".json"));
    } catch {
      return undefined;
    }
    if (!sessionId.trim() || `${encodeURIComponent(sessionId)}.json` !== name) return undefined;
    try {
      const snapshot = await loadClaudeCodeSessionSnapshot(stateDir, sessionId);
      return validSessionState(snapshot, sessionId)
        ? { sessionId, updatedAt: snapshot.updatedAt }
        : undefined;
    } catch {
      return undefined;
    }
  }));

  return sessions
    .filter((session): session is ContextCleanerSession => session !== undefined)
    .sort((left, right) => (
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
      || left.sessionId.localeCompare(right.sessionId)
    ));
}
