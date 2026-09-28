/**
 * Before-call reduction over a canonical `HostRequestEnvelope`.
 *
 * Mirrors the Claude Code adapter's `reduction.ts` (segment metadata, analyzer +
 * fallback instructions, enabled-pass selection) but reads canonical
 * `tool_result` blocks instead of Anthropic payload blocks, so pi and OpenCode
 * share one implementation. All reduction decisions and rewrites come from
 * `@lightrsi/reduction` (`analyze*`, `resolveReductionPasses`,
 * `runReductionBeforeCall`); nothing here changes what a pass does.
 *
 * The one adapter-side addition is `ReductionMemo` (archive-path stabilisation,
 * see docs/adapters/pi-design.md): when a re-run of the shared pipeline changes a
 * segment only in its timestamped `Archive:` line, the first text is reused so the
 * outgoing history stays byte-identical between requests.
 */
import { createHash } from "node:crypto";
import type { HostRequestEnvelope } from "@lightrsi/host-adapter";
import type { ContextSegment, RuntimeContentBlock, RuntimeMessage, RuntimeTurnContext } from "@lightrsi/kernel";
import {
  analyzeExecOutputTruncation,
  analyzeToolPayloadTrim,
  resolveReductionPasses,
  runReductionBeforeCall,
} from "@lightrsi/reduction";
import type { CanonicalAdapterConfig } from "./config.js";

type ReductionInstruction = {
  strategy: string;
  segmentIds: string[];
  confidence: number;
  priority: number;
  rationale: string;
  parameters?: Record<string, unknown>;
};

export type CanonicalReductionReportEntry = {
  id: string;
  phase: string;
  target: string;
  changed: boolean;
  skippedReason?: string;
  note?: string;
  beforeChars: number;
  afterChars: number;
  touchedSegmentIds?: string[];
};

export type CanonicalReductionPassEffect = {
  id: string;
  changed: boolean;
  skippedReason?: string;
  beforeChars: number;
  afterChars: number;
  savedChars: number;
  touchedSegmentIds?: string[];
};

export type CanonicalReductionVisualSegment = {
  segmentId: string;
  messageIndex: number;
  blockIndex: number;
  toolName?: string;
  savedChars: number;
  beforeText: string;
  afterText: string;
  report: CanonicalReductionReportEntry[];
};

export type CanonicalReductionSummary = {
  changedMessages: number;
  changedBlocks: number;
  savedChars: number;
  beforeChars: number;
  afterChars: number;
  report: CanonicalReductionReportEntry[];
  passEffects: CanonicalReductionPassEffect[];
  diagnostics: {
    messageCount: number;
    toolLikeMessages: number;
    candidateSegments: number;
    candidateChars: number;
  };
  visualSegments?: CanonicalReductionVisualSegment[];
  /** Segments whose memoised text replaced an archive-path-only difference. */
  memoReusedSegments?: number;
  skippedReason?: string;
};

type SegmentBinding = {
  segmentId: string;
  messageIndex: number;
  blockIndex: number;
  toolName?: string;
};

/* ------------------------------------------------------------------ *
 * Archive-path memo
 * ------------------------------------------------------------------ */

const ARCHIVE_LINE_RE = /\nArchive: [^\n]*$/;

function stripArchiveLine(text: string): string {
  return text.replace(ARCHIVE_LINE_RE, "\nArchive: <path>");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Per-session memo of first reduction outputs plus disclosed read paths. */
export class ReductionMemo {
  private readonly bySegment = new Map<string, string>();
  disclosedReadPaths: string[] | undefined;

  private key(segmentId: string, originalText: string): string {
    return `${segmentId}\u0000${sha256(originalText)}`;
  }

  /**
   * Return the text to send. When `next` equals the remembered text except for the
   * `Archive:` line, the remembered text wins; otherwise `next` is remembered.
   */
  settle(segmentId: string, originalText: string, next: string): { text: string; reused: boolean } {
    const key = this.key(segmentId, originalText);
    const previous = this.bySegment.get(key);
    if (previous !== undefined && previous !== next && stripArchiveLine(previous) === stripArchiveLine(next)) {
      return { text: previous, reused: true };
    }
    this.bySegment.set(key, next);
    return { text: next, reused: false };
  }

  get size(): number {
    return this.bySegment.size;
  }

  clear(): void {
    this.bySegment.clear();
    this.disclosedReadPaths = undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Segment building (mirrors claude-code/src/reduction.ts)
 * ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function extractPathHint(value: unknown): string | undefined {
  const record = asRecord(value);
  for (const candidate of [record.path, record.file_path, record.filePath, record.filename]) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function isHtmlLikeText(text: string): boolean {
  return /<\/?(html|body|main|section|article|nav|script|style|div|span|a|p|ul|ol|li|table|meta|link)\b/i.test(text);
}

function looksLikeWebPayload(text: string): boolean {
  if (isHtmlLikeText(text)) return true;
  return /\b(<!doctype html|<head\b|<body\b|href=|src=|aria-|data-|document\.|window\.)/i.test(text);
}

function countLines(text: string): number {
  const matches = text.match(/\n/g);
  return matches ? matches.length + 1 : text.length > 0 ? 1 : 0;
}

function payloadKindForText(text: string): "stdout" | "stderr" | "json" | "blob" {
  const trimmed = text.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      return "stdout";
    }
  }
  if (/(\bstderr\b|error:|traceback|exception)/i.test(text)) return "stderr";
  if (isHtmlLikeText(text)) return "blob";
  if (text.length > 500 && countLines(text) <= 2) return "blob";
  return "stdout";
}

function thresholdForTool(toolName: string, config: CanonicalAdapterConfig): number {
  const normalized = toolName.toLowerCase();
  const optionThresholds = config.reduction.passOptions.execOutputTruncation?.toolThresholds;
  if (optionThresholds && typeof optionThresholds === "object" && normalized in optionThresholds) {
    const value = Number((optionThresholds as Record<string, unknown>)[normalized]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  if (normalized === "bash" || normalized === "shell" || normalized === "powershell") return 30_000;
  if (normalized === "grep" || normalized === "rg") return 20_000;
  if (normalized === "read" || normalized === "file_read") return Infinity;
  return 50_000;
}

function segmentForText(params: {
  id: string;
  text: string;
  toolName?: string;
  latestUserQuery: string;
  path?: string;
}): ContextSegment {
  const payloadKind = payloadKindForText(params.text);
  return {
    id: params.id,
    kind: "volatile",
    text: params.text,
    priority: 30,
    source: "canonical.tool_result",
    metadata: {
      role: "tool",
      isToolPayload: true,
      payloadKind,
      latestUserQuery: params.latestUserQuery,
      ...(params.path ? { path: params.path } : {}),
      toolPayload: {
        enabled: true,
        kind: payloadKind,
        toolName: params.toolName ?? "tool",
        ...(params.path ? { path: params.path } : {}),
      },
      reduction: {
        target: "tool_payload",
        payloadKind,
        toolPayloadTrim: { enabled: true, kind: payloadKind },
      },
    },
  };
}

function blockText(content: RuntimeMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" || block.type === "tool_result" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

function latestUserQuery(messages: RuntimeMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    const text = blockText(message.content);
    if (text) return text;
  }
  return "";
}

/** Stable segment id for a tool result: `tool-<callId>` when known, else positional. */
export function canonicalToolResultSegmentId(messageIndex: number, blockIndex: number, toolCallId?: string): string {
  return toolCallId ? `tool-${toolCallId}` : `message-${messageIndex}-block-${blockIndex}`;
}

export function buildCanonicalReductionTurnContext(
  envelope: HostRequestEnvelope,
  options?: { disclosedReadPaths?: string[] },
): {
  turnCtx: RuntimeTurnContext;
  bindings: SegmentBinding[];
  diagnostics: CanonicalReductionSummary["diagnostics"];
} {
  const segments: ContextSegment[] = [];
  const bindings: SegmentBinding[] = [];
  const query = latestUserQuery(envelope.messages);
  const toolCallHints = new Map<string, { toolName?: string; path?: string }>();
  let toolLikeMessages = 0;

  envelope.messages.forEach((message) => {
    if (!Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (block.type !== "tool_call" || !block.toolCallId) continue;
      toolCallHints.set(block.toolCallId, {
        toolName: block.toolName,
        path: extractPathHint(block.argumentsJson),
      });
    }
  });

  envelope.messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content) || message.metadata?.lightrsiPassThrough === true) return;
    let countedToolLike = false;
    message.content.forEach((block: RuntimeContentBlock, blockIndex) => {
      if (block.type !== "tool_result") return;
      if (!countedToolLike) {
        toolLikeMessages += 1;
        countedToolLike = true;
      }
      if (!block.text) return;
      const hint = block.toolCallId ? toolCallHints.get(block.toolCallId) : undefined;
      const toolName = block.toolName ?? hint?.toolName;
      const id = canonicalToolResultSegmentId(messageIndex, blockIndex, block.toolCallId);
      segments.push(segmentForText({ id, text: block.text, toolName, latestUserQuery: query, path: hint?.path }));
      bindings.push({ segmentId: id, messageIndex, blockIndex, toolName });
    });
  });

  return {
    turnCtx: {
      sessionId: envelope.session.sessionId,
      sessionMode: "single",
      provider: envelope.session.host.hostId,
      model: envelope.model,
      apiFamily: "openai-completions",
      prompt: query,
      budget: { maxInputTokens: 0, reserveOutputTokens: 0 },
      segments,
      metadata: {
        latestUserQuery: query,
        ...(options?.disclosedReadPaths ? { disclosedReadPaths: options.disclosedReadPaths } : {}),
      },
    },
    bindings,
    diagnostics: {
      messageCount: envelope.messages.length,
      toolLikeMessages,
      candidateSegments: segments.length,
      candidateChars: segments.reduce((sum, segment) => sum + segment.text.length, 0),
    },
  };
}

function analyzerInstructions(segments: ContextSegment[], config: CanonicalAdapterConfig): ReductionInstruction[] {
  const instructions: ReductionInstruction[] = [];
  if (config.reduction.passes.toolPayloadTrim) {
    instructions.push(...analyzeToolPayloadTrim(segments, {
      enabled: true,
      minChars: 120,
      minSavedChars: Math.max(300, Math.floor(config.reduction.maxToolChars * 0.25)),
      onlyLikelyToolSegments: false,
    }).instructions);
  }
  if (config.reduction.passes.execOutputTruncation) {
    const toolThresholds = config.reduction.passOptions.execOutputTruncation?.toolThresholds;
    instructions.push(...analyzeExecOutputTruncation(segments, {
      enabled: true,
      toolThresholds: toolThresholds && typeof toolThresholds === "object"
        ? toolThresholds as Record<string, number>
        : {},
      minExcessChars: 1000,
    }).instructions);
  }
  return instructions;
}

function fallbackInstructions(segments: ContextSegment[], config: CanonicalAdapterConfig): ReductionInstruction[] {
  const instructions: ReductionInstruction[] = [];
  const byKind = new Map<string, ContextSegment[]>();
  const execSegmentIds: string[] = [];

  for (const segment of segments) {
    const meta = segment.metadata ?? {};
    const toolPayload = asRecord(meta.toolPayload);
    const toolName = typeof toolPayload.toolName === "string" && toolPayload.toolName.trim()
      ? toolPayload.toolName.trim()
      : "tool";
    const payloadKind = typeof meta.payloadKind === "string" ? meta.payloadKind : payloadKindForText(segment.text);
    const isWeb = looksLikeWebPayload(segment.text);

    if (config.reduction.passes.toolPayloadTrim && segment.text.length >= (isWeb ? 120 : 200)) {
      const key = payloadKind === "json" || payloadKind === "stderr" || payloadKind === "blob" ? payloadKind : "stdout";
      const existing = byKind.get(key) ?? [];
      existing.push(segment);
      byKind.set(key, existing);
    }
    const execThreshold = thresholdForTool(toolName, config);
    if (config.reduction.passes.execOutputTruncation && Number.isFinite(execThreshold) && segment.text.length > execThreshold) {
      execSegmentIds.push(segment.id);
    }
  }

  for (const [kind, kindSegments] of byKind) {
    const totalChars = kindSegments.reduce((sum, segment) => sum + segment.text.length, 0);
    const hasWeb = kindSegments.some((segment) => looksLikeWebPayload(segment.text));
    const minGroupChars = hasWeb
      ? Math.max(300, Math.floor(config.reduction.maxToolChars * 0.25))
      : Math.max(600, Math.floor(config.reduction.maxToolChars * 0.5));
    if (totalChars < minGroupChars) continue;
    instructions.push({
      strategy: "tool_payload_trim",
      segmentIds: kindSegments.map((segment) => segment.id),
      confidence: kind === "json" ? 0.9 : kind === "stdout" ? 0.8 : 0.75,
      priority: hasWeb ? 9 : 8,
      rationale: `canonical tool payload trim: ${kindSegments.length} ${kind} segment(s), ${totalChars} chars`,
      parameters: { payloadKind: kind, segmentCount: kindSegments.length, totalChars },
    });
  }
  if (execSegmentIds.length > 0) {
    instructions.push({
      strategy: "exec_output_truncation",
      segmentIds: execSegmentIds,
      confidence: 0.99,
      priority: 10,
      rationale: `canonical large tool output truncation: ${execSegmentIds.length} segment(s)`,
    });
  }
  return instructions.sort((a, b) => b.priority - a.priority);
}

function dedupeInstructions(instructions: ReductionInstruction[]): ReductionInstruction[] {
  const seen = new Set<string>();
  const result: ReductionInstruction[] = [];
  for (const instruction of instructions) {
    const key = `${instruction.strategy}:${[...instruction.segmentIds].sort().join(",")}:${JSON.stringify(instruction.parameters ?? {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(instruction);
  }
  return result.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

function withReductionPolicy(turnCtx: RuntimeTurnContext, instructions: ReductionInstruction[]): RuntimeTurnContext {
  if (instructions.length === 0) return turnCtx;
  const policy = asRecord(turnCtx.metadata?.policy);
  const decisions = asRecord(policy.decisions);
  const reduction = asRecord(decisions.reduction);
  const existing = Array.isArray(reduction.instructions) ? reduction.instructions as unknown[] : [];
  return {
    ...turnCtx,
    metadata: {
      ...(turnCtx.metadata ?? {}),
      policy: {
        ...policy,
        decisions: {
          ...decisions,
          reduction: { ...reduction, instructions: [...existing, ...instructions] },
        },
      },
    },
  };
}

export function canonicalPassOptions(config: CanonicalAdapterConfig): Record<string, Record<string, unknown>> {
  return {
    read_state_compaction: config.reduction.passOptions.readStateCompaction ?? {},
    tool_payload_trim: {
      maxChars: config.reduction.maxToolChars,
      ...(config.reduction.passOptions.toolPayloadTrim ?? {}),
    },
    html_slimming: config.reduction.passOptions.htmlSlimming ?? {},
    exec_output_truncation: config.reduction.passOptions.execOutputTruncation ?? {},
    agents_startup_optimization: config.reduction.passOptions.agentsStartupOptimization ?? {},
  };
}

export function canonicalEnabledPassIds(config: CanonicalAdapterConfig): Set<string> {
  const ids = new Set<string>();
  if (config.reduction.passes.readStateCompaction) ids.add("read_state_compaction");
  if (config.reduction.passes.toolPayloadTrim) ids.add("tool_payload_trim");
  if (config.reduction.passes.htmlSlimming) ids.add("html_slimming");
  if (config.reduction.passes.execOutputTruncation) ids.add("exec_output_truncation");
  if (config.reduction.passes.agentsStartupOptimization) ids.add("agents_startup_optimization");
  return ids;
}

/**
 * Build the exact inputs the shared pipeline receives (turn context with policy
 * instructions and the enabled before-call passes). Exported so tests can call
 * `runReductionBeforeCall` directly and assert that the adapter adds no drift.
 */
export function prepareCanonicalReductionInputs(
  envelope: HostRequestEnvelope,
  config: CanonicalAdapterConfig,
  options?: { disclosedReadPaths?: string[] },
) {
  const built = buildCanonicalReductionTurnContext(envelope, options);
  const instructions = dedupeInstructions([
    ...analyzerInstructions(built.turnCtx.segments, config),
    ...fallbackInstructions(built.turnCtx.segments, config),
  ]);
  const turnCtx = withReductionPolicy(built.turnCtx, instructions);
  const enabled = canonicalEnabledPassIds(config);
  const passes = resolveReductionPasses({
    maxToolChars: config.reduction.maxToolChars,
    passOptions: canonicalPassOptions(config),
  }).filter((pass) => pass.phase === "before_call" && enabled.has(pass.id));
  return { turnCtx, passes, bindings: built.bindings, diagnostics: built.diagnostics };
}

function emptySummary(
  diagnostics: CanonicalReductionSummary["diagnostics"],
  skippedReason: string,
  chars = 0,
): CanonicalReductionSummary {
  return {
    changedMessages: 0,
    changedBlocks: 0,
    savedChars: 0,
    beforeChars: chars,
    afterChars: chars,
    report: [],
    passEffects: [],
    diagnostics,
    skippedReason,
  };
}

/**
 * Reduce tool-result text in a canonical envelope. Returns a new envelope (the
 * input is never mutated) and a summary shaped like Claude Code's.
 */
export async function reduceCanonicalEnvelope(params: {
  envelope: HostRequestEnvelope;
  config: CanonicalAdapterConfig;
  memo?: ReductionMemo;
}): Promise<{ envelope: HostRequestEnvelope; summary: CanonicalReductionSummary }> {
  const { envelope, config, memo } = params;
  const noDiagnostics = { messageCount: envelope.messages.length, toolLikeMessages: 0, candidateSegments: 0, candidateChars: 0 };
  if (!config.modules.reduction) {
    return { envelope, summary: emptySummary(noDiagnostics, "disabled") };
  }

  const prepared = prepareCanonicalReductionInputs(envelope, config, {
    disclosedReadPaths: memo?.disclosedReadPaths,
  });
  const totalChars = prepared.diagnostics.candidateChars;
  if (prepared.turnCtx.segments.length === 0 || totalChars < config.reduction.triggerMinChars) {
    return {
      envelope,
      summary: emptySummary(
        prepared.diagnostics,
        prepared.turnCtx.segments.length === 0 ? "no_candidate_segments" : "below_trigger_min_chars",
        totalChars,
      ),
    };
  }

  const { turnCtx: reducedCtx, report } = await runReductionBeforeCall({
    turnCtx: prepared.turnCtx,
    passes: prepared.passes,
  });
  if (memo) {
    const disclosed = reducedCtx.metadata?.disclosedReadPaths;
    if (Array.isArray(disclosed)) memo.disclosedReadPaths = disclosed.filter((entry): entry is string => typeof entry === "string");
  }
  const passEffects = report.map((entry) => ({
    id: String(entry.id),
    changed: entry.changed,
    skippedReason: entry.skippedReason,
    beforeChars: entry.beforeChars,
    afterChars: entry.afterChars,
    savedChars: Math.max(0, entry.beforeChars - entry.afterChars),
    touchedSegmentIds: entry.touchedSegmentIds,
  }));
  const changedSegmentIds = new Set<string>();
  for (const entry of report) {
    if (!entry.changed) continue;
    for (const id of entry.touchedSegmentIds ?? []) changedSegmentIds.add(id);
  }
  if (changedSegmentIds.size === 0) {
    return {
      envelope,
      summary: { ...emptySummary(prepared.diagnostics, "pipeline_no_effect", totalChars), report, passEffects },
    };
  }

  const segmentMap = new Map(reducedCtx.segments.map((segment) => [segment.id, segment]));
  const originalMap = new Map(prepared.turnCtx.segments.map((segment) => [segment.id, segment]));
  const messages = envelope.messages.slice();
  const changedMessages = new Set<number>();
  const visualSegments: CanonicalReductionVisualSegment[] = [];
  let changedBlocks = 0;
  let savedChars = 0;
  let memoReusedSegments = 0;

  for (const binding of prepared.bindings) {
    if (!changedSegmentIds.has(binding.segmentId)) continue;
    const segment = segmentMap.get(binding.segmentId);
    const original = originalMap.get(binding.segmentId);
    const message = messages[binding.messageIndex];
    if (!segment || !original || !message || !Array.isArray(message.content)) continue;
    const block = message.content[binding.blockIndex];
    if (!block || block.type !== "tool_result" || block.text === segment.text) continue;

    let nextText = segment.text;
    if (memo && config.reduction.stableArchiveHints) {
      const settled = memo.settle(binding.segmentId, original.text, segment.text);
      nextText = settled.text;
      if (settled.reused) memoReusedSegments += 1;
    }
    const before = block.text;
    const content = message.content.slice();
    content[binding.blockIndex] = { ...block, text: nextText };
    messages[binding.messageIndex] = { ...message, content };

    changedBlocks += 1;
    changedMessages.add(binding.messageIndex);
    const segmentSaved = Math.max(0, before.length - nextText.length);
    savedChars += segmentSaved;
    visualSegments.push({
      segmentId: binding.segmentId,
      messageIndex: binding.messageIndex,
      blockIndex: binding.blockIndex,
      toolName: binding.toolName,
      savedChars: segmentSaved,
      beforeText: before,
      afterText: nextText,
      report: report.filter((entry) => entry.changed && entry.touchedSegmentIds?.includes(binding.segmentId)),
    });
  }

  return {
    envelope: changedBlocks > 0 ? { ...envelope, messages } : envelope,
    summary: {
      changedMessages: changedMessages.size,
      changedBlocks,
      savedChars,
      beforeChars: totalChars,
      afterChars: Math.max(0, totalChars - savedChars),
      report,
      passEffects,
      diagnostics: prepared.diagnostics,
      visualSegments,
      memoReusedSegments,
    },
  };
}
