/**
 * Request-time pipeline for in-process canonical adapters (pi, OpenCode).
 *
 * Reduction runs through the shared `prepareObservedBeforeCall` (same helper the
 * Claude Code gateway uses), so ux-effects, report aggregates and the browser
 * visual are recorded identically. The stable-prefix step lives in each host's
 * system-prompt hook (`applyCanonicalStablePrefix` below) because pi and OpenCode
 * expose the system prompt separately from the message history.
 */
import {
  appendRecoveryProtocolText,
  defaultInjectRecoveryProtocol,
  type HostPayloadCodec,
  type HostRequestEnvelope,
  type HostSessionContext,
} from "@lightrsi/host-adapter";
import type { RuntimeMessage } from "@lightrsi/kernel";
import {
  prepareObservedBeforeCall,
  writeStabilityVisualSnapshot,
} from "@lightrsi/product-surface";
import {
  applyStablePrefixToInstructions,
  buildStabilityVisualSnapshotFromEnvelopes,
  rewriteTextForStablePrefix,
} from "@lightrsi/stabilizer";
import type { CanonicalAdapterConfig } from "./config.js";
import { reduceCanonicalEnvelope, type CanonicalReductionSummary, type ReductionMemo } from "./reduction.js";

/** Envelopes here are already canonical; the codec is the identity. */
export const CANONICAL_IDENTITY_CODEC: HostPayloadCodec = {
  decodeRequest(rawPayload) {
    return rawPayload as HostRequestEnvelope;
  },
  encodeRequest(envelope) {
    return envelope;
  },
  decodeResponse(rawResponse, request) {
    return { request, rawResponse } as never;
  },
  encodeResponse(_envelope, originalRawResponse) {
    return originalRawResponse;
  },
};

export function createCanonicalEnvelope(params: {
  hostId: string;
  displayName: string;
  sessionId: string;
  turnId?: string;
  model: string;
  instructions?: string;
  messages: RuntimeMessage[];
  metadata?: Record<string, unknown>;
}): HostRequestEnvelope {
  const session: HostSessionContext = {
    host: { hostId: params.hostId, displayName: params.displayName },
    sessionId: params.sessionId,
    ...(params.turnId ? { turnId: params.turnId } : {}),
    sessionMode: "single",
  };
  return {
    session,
    model: params.model,
    stream: true,
    ...(params.instructions !== undefined ? { instructions: params.instructions } : {}),
    messages: params.messages,
    rawPayload: undefined,
    metadata: params.metadata,
  };
}

export async function runCanonicalBeforeCallReduction(params: {
  envelope: HostRequestEnvelope;
  config: CanonicalAdapterConfig;
  memo?: ReductionMemo;
}): Promise<{ messages: RuntimeMessage[]; summary?: CanonicalReductionSummary }> {
  const { envelope, config } = params;
  const sessionId = envelope.session.sessionId;
  const prepared = await prepareObservedBeforeCall<CanonicalReductionSummary>({
    envelope,
    codec: CANONICAL_IDENTITY_CODEC,
    config: { mode: "normal" },
    prepareStablePrefix: (next) => next,
    applyBeforeCallReduction: ({ envelope: next }) => reduceCanonicalEnvelope({ envelope: next, config, memo: params.memo }),
    observability: {
      stateDir: config.stateDir,
      sessionId,
      model: envelope.model,
      recordUxEffectNow: true,
      buildReduction(summary) {
        return summary.savedChars > 0
          ? {
            countMode: "chars",
            beforeCount: summary.beforeChars,
            afterCount: summary.afterChars,
            savedCount: summary.savedChars,
            details: { requestSavedCount: summary.savedChars },
            segments: (summary.visualSegments ?? []).map((segment) => ({
              segmentId: segment.segmentId,
              itemIndex: segment.messageIndex,
              field: "content",
              blockIndex: segment.blockIndex,
              toolName: segment.toolName,
              savedChars: segment.savedChars,
              beforeText: segment.beforeText,
              afterText: segment.afterText,
              report: segment.report,
            })),
          }
          : undefined;
      },
    },
  });
  // The shared pipeline also appends the recovery protocol to `instructions`.
  // pi and OpenCode own their system prompt through separate hooks, which inject
  // it via `withCanonicalRecoveryProtocol`; only messages are returned here so the
  // two paths cannot silently diverge.
  return { messages: prepared.envelope.messages, summary: prepared.reductionSummary };
}

/**
 * The shared recovery protocol text, obtained from the shared injector so it is
 * never duplicated here. Empty when `TOKENPILOT_DISABLE_RECOVERY_PROTOCOL` is set.
 */
export function canonicalRecoveryProtocolText(): string {
  const probe = defaultInjectRecoveryProtocol({
    session: { host: { hostId: "canonical", displayName: "canonical" }, sessionId: "", sessionMode: "single" },
    model: "",
    stream: false,
    instructions: "",
    messages: [],
    rawPayload: undefined,
  });
  return typeof probe.instructions === "string" ? probe.instructions : "";
}

/** Append the shared recovery protocol to a system prompt once (idempotent). */
export function withCanonicalRecoveryProtocol(systemText: string): { changed: boolean; text: string } {
  const protocolText = canonicalRecoveryProtocolText();
  if (!protocolText) return { changed: false, text: systemText };
  const result = appendRecoveryProtocolText({ currentInstructions: systemText, protocolText });
  return { changed: result.changed, text: result.instructions };
}

export type CanonicalStablePrefixResult = {
  changed: boolean;
  /** System/instruction text to send. */
  instructions: string;
  /** Volatile lines removed from the stable prefix. */
  dynamicContextText: string;
  /** For target `user`: text to prepend to the first user message (request-local). */
  userPrefix?: string;
};

/**
 * Apply the shared stabilizer to one system-prompt text. Target `developer` keeps
 * the volatile lines in the system prompt but moves them to its tail
 * (`mergeDynamicContextIntoInstructions`); target `user` removes them from the
 * system prompt and returns them for the first user message.
 */
export function applyCanonicalStablePrefix(
  instructions: string,
  config: CanonicalAdapterConfig,
): CanonicalStablePrefixResult {
  const unchanged = { changed: false, instructions, dynamicContextText: "" };
  if (!config.modules.stabilizer || !instructions.trim()) return unchanged;
  const target = config.hooks.dynamicContextTarget;
  const rewrite = rewriteTextForStablePrefix(instructions);
  if (!rewrite.changed || !rewrite.dynamicContextText) return unchanged;
  const probe = applyStablePrefixToInstructions({
    envelope: {
      session: { host: { hostId: "canonical" } },
      model: "",
      instructions,
      messages: [{ role: "user", content: "" }],
    },
    dynamicContextTarget: target,
    mergeDynamicContextIntoInstructions: target === "developer",
  });
  const next = typeof probe.instructions === "string" ? probe.instructions : instructions;
  return {
    changed: next !== instructions,
    instructions: next,
    dynamicContextText: rewrite.dynamicContextText,
    ...(target === "user" ? { userPrefix: rewrite.dynamicContextText } : {}),
  };
}

export async function recordCanonicalStability(params: {
  config: CanonicalAdapterConfig;
  sessionId: string;
  model: string;
  before: string;
  result: CanonicalStablePrefixResult;
}): Promise<void> {
  if (!params.result.changed) return;
  const snapshot = buildStabilityVisualSnapshotFromEnvelopes({
    sessionId: params.sessionId,
    model: params.model,
    upstreamModel: params.model,
    originalEnvelope: { instructions: params.before, messages: [] },
    preparedEnvelope: { instructions: params.result.instructions, messages: [] },
    dynamicContextTarget: params.config.hooks.dynamicContextTarget,
    dynamicContextText: params.result.dynamicContextText,
    getDeveloperText: (envelope) => (typeof envelope.instructions === "string" ? envelope.instructions : ""),
  });
  await writeStabilityVisualSnapshot({ stateDir: params.config.stateDir, snapshot });
}
