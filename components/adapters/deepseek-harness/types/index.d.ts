export interface DshPluginContext {
  on(
    event: "agent/pre-step",
    handler: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>,
  ): void;
  tokenMeter?: {
    measure(session: unknown): unknown;
  };
  commands?: {
    register(definition: unknown): () => void;
  };
  inject?(
    services: readonly string[],
    callback: (scope: unknown) => void,
  ): unknown;
}

export declare const name = "tokenpilot-dsh";
/** The root plugin is headless-safe; optional Cordis services are injected in apply(). */
export declare const inject: readonly string[];
export declare function apply(ctx: unknown, rawConfig?: unknown): void;

export interface DshCleanerCapabilityParams {
  stateDir: string;
  sessions: {
    list(): readonly unknown[];
    get(sessionId: string): unknown;
  };
  loadRegistry(sessionId: string): unknown | Promise<unknown>;
}

/** Public factory; its host-neutral result is intentionally opaque here. */
export declare function createDshCleanerCapabilities(
  params: DshCleanerCapabilityParams,
): unknown;

/**
 * The metadata-only contract exposed to a process outside the DSH Host.
 * It intentionally contains no DSH event, message, Cordis, or live-surface
 * object. Fields needed by a CLI renderer are kept structural so a packed
 * adapter does not require the private workspace Cleaner package for types.
 */
export type DshPersistedContextCleanTask = {
  taskId: string;
  label: string;
  description: string;
  summary: string;
  lifecycleState: "active" | "unresolved" | "completed" | "aborted" | "unknown";
  itemIds: string[];
  itemDigests: Record<string, string>;
  tokenCount: number | null;
  charCount: number;
  tokenPercent: number | null;
  recommendation: "clean" | "keep" | "protected";
  reasonCodes: string[];
  selectable: boolean;
};

export type DshPersistedContextCleanPlan = {
  schemaVersion: 1;
  planId: string;
  hostId: "deepseek-harness";
  sessionId: string;
  baseRevision: string;
  usedTokens: number | null;
  usedChars: number;
  protectedTokens: number | null;
  protectedChars: number;
  unassignedTokens: number | null;
  unassignedChars: number;
  tokenCountMode: "exact" | "estimated" | "chars_only";
  tokenCountMethod: string;
  tasks: DshPersistedContextCleanTask[];
  createdAt: string;
};

export type DshPersistedContextCleanReceipt = {
  schemaVersion: 1;
  planId: string;
  hostId: "deepseek-harness";
  sessionId: string;
  status: "analyzed" | "approved" | "scheduled" | "applied" | "stale" | "cancelled" | "failed";
  selectedTaskIds: string[];
  estimatedSavedTokens: number | null;
  estimatedSavedChars: number;
  tokenCountMode: "exact" | "estimated" | "chars_only";
  deferredTaskIds: string[];
  reasons: string[];
  updatedAt: string;
  fallbackUsed: boolean;
  appliedSavedTokens?: number | null;
  appliedSavedChars?: number;
  evidence?: {
    previousRevision?: string;
    nextRevision?: string;
    operationIds?: string[];
    itemIds?: string[];
    eventIds?: string[];
  };
};

/** Safe external control surface: it can analyze and schedule, never rewrite DSH. */
export interface DshPersistedCleanerControlService {
  analyze(sessionId: string): Promise<DshPersistedContextCleanPlan>;
  readPlan(planId: string): Promise<DshPersistedContextCleanPlan | undefined>;
  approve(planId: string, selectedTaskIds: readonly string[]): Promise<DshPersistedContextCleanReceipt>;
  readReceipt(planId: string): Promise<DshPersistedContextCleanReceipt | undefined>;
  cancel(planId: string): Promise<DshPersistedContextCleanReceipt>;
}

/**
 * Create a stateDir-only external control service. DSH must have published a
 * fresh snapshot first. The returned object has no path to a live surface.
 */
export declare function createDshPersistedCleanerControlService(params: {
  stateDir: string;
  maxSnapshotAgeMs?: number;
  now?: () => string;
  snapshotNow?: () => number;
}): DshPersistedCleanerControlService;

/**
 * Structural metadata returned to an external CLI.  This deliberately omits
 * raw prompt/response text and every DSH/Cordis runtime object.
 */
export type DshPersistedContextItem = {
  stableId: string;
  kind: string;
  role: string;
  callId?: string;
  responseId?: string;
  taskIds?: string[];
  fingerprint: string;
  chars: number;
};

export type DshPersistedContextCleanSnapshot = {
  schemaVersion: number;
  hostId: "deepseek-harness";
  sessionId: string;
  revision: string;
  items: DshPersistedContextItem[];
  capturedAt: string;
  model?: string;
  tokenCountMode: "exact" | "estimated" | "chars_only";
  tokenCountMethod: string;
  itemTokenCounts?: Record<string, number>;
};

export type DshPersistedCleanerScheduleRequest = {
  sessionId: string;
  cleanPlanId: string;
  baseRevision: string;
  selectedTaskIds: string[];
  scheduledAt: string;
};

export type DshPersistedCleanerScheduleResult = {
  outcome: "stored" | "unchanged" | "transitioned" | "missing" | "conflict" | "bypassed";
  reasons: string[];
};

/**
 * StateDir-only capabilities suitable for a separately running CLI.  The
 * schedule writer records only a Host-owned pointer; it cannot mutate a DSH
 * surface.  The regular DSH pre-step performs the eventual live rewrite.
 */
export interface DshPersistedCleanerCapabilities {
  readonly hostId: "deepseek-harness";
  readonly rewriteMode: "canonical";
  readonly snapshotSource: {
    readonly hostId: "deepseek-harness";
    readonly rewriteMode: "canonical";
    readCleanSnapshot(sessionId: string): Promise<DshPersistedContextCleanSnapshot>;
  };
  readonly sessionCatalog: {
    listSessions(): Promise<Array<{ sessionId: string; updatedAt?: string }>>;
  };
  readonly scheduleWriter: {
    writeSchedule(
      request: DshPersistedCleanerScheduleRequest,
    ): Promise<DshPersistedCleanerScheduleResult>;
    abortSchedule(
      request: DshPersistedCleanerScheduleRequest & {
        receiptStatus: "stale" | "cancelled" | "failed";
        reasons: string[];
        updatedAt: string;
      },
    ): Promise<DshPersistedCleanerScheduleResult>;
  };
}

/** Public stateDir-only capability factory used by shared CLI composition. */
export declare function createDshPersistedCleanerCapabilities(params: {
  stateDir: string;
  maxSnapshotAgeMs?: number;
  now?: () => number;
}): DshPersistedCleanerCapabilities;

/** Resolve a LightRSI-owned state directory without reading DSH session data. */
export declare function resolveDshStateDir(config: unknown): string | undefined;
/** Metadata consumed by LightRSI product/CLI composition. */
export declare const DSH_PRODUCT_HOST_REGISTRATION: unknown;
