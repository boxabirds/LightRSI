import type { ContextCleanerSnapshotSource } from "@lightrsi/cleaner";
import { loadCanonicalState, type CanonicalTranscriptState } from "@lightrsi/history";
import {
  createOpenClawReferenceBackend,
  type OpenClawReferenceBackendRequest,
} from "../context-rewrite/reference-backend.js";
import { appendTaskStateTrace } from "../trace/io.js";
import { asRecord, extractPathLike, safeId } from "../context-stack/integration/config-types.js";
import { contentToText } from "../context-stack/integration/runtime-event-text.js";
import {
  canonicalMessageTaskIds,
  dedupeStrings,
  ensureContextSafeDetails,
  extractToolMessageText,
  isToolResultLikeMessage,
  messageToolCallId,
} from "../context-stack/integration/runtime-tooling.js";

/** Adapter-only request construction; native state never crosses the Cleaner boundary. */
export function createOpenClawCleanerRewriteRequest(params: {
  stateDir: string;
  state: CanonicalTranscriptState;
  replacementMode: "pointer_stub" | "drop";
}): OpenClawReferenceBackendRequest {
  return {
    stateDir: params.stateDir,
    sessionId: params.state.sessionId,
    state: params.state,
    evictionEnabled: true,
    evictionPolicy: "model_scored",
    evictionMinBlockChars: 0,
    evictionReplacementMode: params.replacementMode,
    helpers: {
      appendTaskStateTrace,
      asRecord,
      canonicalMessageTaskIds: (message) => canonicalMessageTaskIds(message, asRecord),
      contentToText,
      dedupeStrings,
      ensureContextSafeDetails,
      extractPathLike,
      extractToolMessageText,
      isToolResultLikeMessage,
      messageToolCallId,
      safeId,
      logger: { info: () => undefined },
    },
  };
}

export async function readOpenClawCleanerState(
  stateDir: string,
  sessionId: string,
): Promise<CanonicalTranscriptState> {
  const state = await loadCanonicalState(stateDir, sessionId);
  if (!state) throw new Error("openclaw_clean_session_not_found");
  const timestamp = Date.parse(state.updatedAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== state.updatedAt) {
    throw new Error("openclaw_clean_snapshot_timestamp_invalid");
  }
  return state;
}

export function createOpenClawCleanerSnapshotSource(params: {
  stateDir: string;
  replacementMode: "pointer_stub" | "drop";
}): ContextCleanerSnapshotSource {
  if (!params.stateDir.trim()) throw new Error("openclaw_clean_state_dir_missing");
  const backend = createOpenClawReferenceBackend();
  return {
    hostId: "openclaw",
    rewriteMode: "canonical",
    async readCleanSnapshot(sessionId) {
      const state = await readOpenClawCleanerState(params.stateDir, sessionId);
      const request = createOpenClawCleanerRewriteRequest({ ...params, state });
      const { adapterMetadata: _metadata, ...snapshot } = await backend.readSnapshot({
        sessionId,
        request,
      });
      return {
        ...snapshot,
        capturedAt: state.updatedAt,
        tokenCountMode: "chars_only",
        tokenCountMethod: "utf16_chars",
      };
    },
  };
}
