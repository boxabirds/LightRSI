import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ContextCleanerScheduleRequest, ContextCleanerScheduleWriteResult } from "@lightrsi/cleaner";
import { writeJsonFileAtomic } from "@lightrsi/host-adapter";
import { withOpenClawCleanerSessionLock } from "./session-lock.js";

const SCHEMA = "lightrsi.openclaw.cleaner-schedule/v1";
export type OpenClawCleanerSchedule = ContextCleanerScheduleRequest & {
  schema: typeof SCHEMA;
  hostId: "openclaw";
  updatedAt: string;
  status: "scheduled" | "terminal";
};

export function openClawCleanerSchedulePath(stateDir: string, sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return join(stateDir, "context-cleaner", "openclaw-schedules", `${digest}.json`);
}

function valid(request: ContextCleanerScheduleRequest): boolean {
  return [request.sessionId, request.cleanPlanId, request.baseRevision]
    .every((value) => typeof value === "string" && value.trim().length > 0)
    && typeof request.scheduledAt === "string" && Number.isFinite(Date.parse(request.scheduledAt))
    && Array.isArray(request.selectedTaskIds) && request.selectedTaskIds.length > 0
    && request.selectedTaskIds.every((id) => typeof id === "string" && id.trim().length > 0)
    && new Set(request.selectedTaskIds).size === request.selectedTaskIds.length;
}

function same(left: ContextCleanerScheduleRequest, right: ContextCleanerScheduleRequest): boolean {
  return left.sessionId === right.sessionId && left.cleanPlanId === right.cleanPlanId
    && left.baseRevision === right.baseRevision && left.scheduledAt === right.scheduledAt
    && left.selectedTaskIds.length === right.selectedTaskIds.length
    && left.selectedTaskIds.every((id) => right.selectedTaskIds.includes(id));
}

export async function readOpenClawCleanerSchedule(
  stateDir: string, sessionId: string,
): Promise<OpenClawCleanerSchedule | undefined> {
  let record: OpenClawCleanerSchedule;
  try { record = JSON.parse(await readFile(openClawCleanerSchedulePath(stateDir, sessionId), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("openclaw_clean_schedule_unreadable");
  }
  if (!record || !valid(record) || record.schema !== SCHEMA || record.hostId !== "openclaw"
    || record.sessionId !== sessionId || !["scheduled", "terminal"].includes(record.status)
    || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new Error("openclaw_clean_schedule_invalid");
  }
  return record;
}

async function updateSchedule(
  stateDir: string, request: ContextCleanerScheduleRequest, terminalAt?: string,
): Promise<ContextCleanerScheduleWriteResult> {
  if (!valid(request) || (terminalAt !== undefined && !Number.isFinite(Date.parse(terminalAt)))) {
    return { outcome: "bypassed", reasons: ["openclaw_clean_schedule_request_invalid"] };
  }
  const path = openClawCleanerSchedulePath(stateDir, request.sessionId);
  await mkdir(dirname(path), { recursive: true });
  try {
    return await withOpenClawCleanerSessionLock({ stateDir, sessionId: `schedule:${request.sessionId}`, action: async () => {
      const current = await readOpenClawCleanerSchedule(stateDir, request.sessionId);
      if (terminalAt !== undefined) {
        if (!current) return { outcome: "missing", reasons: [] };
        if (!same(current, request)) return { outcome: "conflict", reasons: ["openclaw_clean_schedule_conflict"] };
        if (current.status === "terminal") return { outcome: "unchanged", reasons: [] };
        await writeJsonFileAtomic(path, { ...current, status: "terminal", updatedAt: terminalAt });
        return { outcome: "transitioned", reasons: [] };
      }
      if (current && same(current, request)) return { outcome: "unchanged", reasons: [] };
      if (current && (current.status !== "terminal" || current.cleanPlanId === request.cleanPlanId)) {
        return { outcome: "conflict", reasons: ["openclaw_clean_schedule_conflict"] };
      }
      const record: OpenClawCleanerSchedule = {
        schema: SCHEMA, hostId: "openclaw", sessionId: request.sessionId,
        cleanPlanId: request.cleanPlanId, baseRevision: request.baseRevision,
        selectedTaskIds: [...request.selectedTaskIds], scheduledAt: request.scheduledAt,
        updatedAt: request.scheduledAt, status: "scheduled",
      };
      await writeJsonFileAtomic(path, record);
      return { outcome: "stored", reasons: [] };
    } });
  } catch {
    return { outcome: "bypassed", reasons: ["openclaw_clean_schedule_unavailable"] };
  }
}

export const scheduleOpenClawClean = (stateDir: string, request: ContextCleanerScheduleRequest) =>
  updateSchedule(stateDir, request);
export const finishOpenClawCleanSchedule = (
  stateDir: string, request: ContextCleanerScheduleRequest, updatedAt: string,
) => updateSchedule(stateDir, request, updatedAt);
