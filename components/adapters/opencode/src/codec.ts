/**
 * OpenCode transcript bridge: `{ info, parts }[]` ↔ canonical `RuntimeMessage[]`.
 *
 * Mirrors what OpenCode 1.18.33 sends the model (`session/message-v2.ts`
 * `toModelMessagesEffect`):
 *   user text (not `ignored`, not empty) → user text blocks; image files → image blocks
 *   assistant text → text; reasoning → metadata; completed/error tool part →
 *     tool_call on the assistant message + a following canonical `tool` message
 *     with the output (the `[Old tool result content cleared]` placeholder when
 *     natively pruned, the error text for errors)
 *   pending/running tool parts, step/snapshot/patch/agent/retry/compaction/subtask
 *     parts → not decoded (never rewritten)
 *
 * Every canonical message remembers where it came from (`OcBinding`). Encoding
 * writes changed text into CLONED parts/messages and swaps them into the array;
 * stored objects are never mutated, and an unchanged envelope leaves the array
 * untouched.
 */
import type { RuntimeContentBlock, RuntimeMessage } from "@lightrsi/kernel";
import type { CanonicalSurfaceEntry } from "../../shared/canonical/eviction.js";
import type { OcMessageWithParts, OcPart, OcTextPart, OcToolPart } from "./opencode-types.js";

export const OC_PRUNED_PLACEHOLDER = "[Old tool result content cleared]";

export type OcBinding =
  | { kind: "user"; messageIndex: number; textPartIndexes: number[] }
  | { kind: "assistant"; messageIndex: number; textPartIndexes: number[] }
  | { kind: "tool"; messageIndex: number; partIndex: number };

export type OcDecoded = {
  messages: RuntimeMessage[];
  bindings: OcBinding[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolPart(part: OcPart): part is OcToolPart {
  return part?.type === "tool" && isRecord((part as OcToolPart).state);
}

function toolResultText(part: OcToolPart): { text: string; status: "success" | "error" } | undefined {
  const state = part.state;
  if (state.status === "completed") {
    return { text: state.time?.compacted ? OC_PRUNED_PLACEHOLDER : String(state.output ?? ""), status: "success" };
  }
  if (state.status === "error") {
    const interrupted = isRecord(state.metadata) && state.metadata.interrupted === true && typeof state.metadata.output === "string";
    return interrupted
      ? { text: String((state.metadata as Record<string, unknown>).output), status: "success" }
      : { text: String(state.error ?? ""), status: "error" };
  }
  return undefined;
}

export function decodeOpenCodeMessages(messages: readonly OcMessageWithParts[]): OcDecoded {
  const out: RuntimeMessage[] = [];
  const bindings: OcBinding[] = [];
  messages.forEach((message, messageIndex) => {
    if (!isRecord(message) || !isRecord(message.info) || !Array.isArray(message.parts)) return;
    const role = message.info.role;
    const meta = { ocMessageId: String(message.info.id ?? ""), ocIndex: messageIndex };
    if (role === "user") {
      const blocks: RuntimeContentBlock[] = [];
      const textPartIndexes: number[] = [];
      message.parts.forEach((part, partIndex) => {
        if (!isRecord(part)) return;
        if (part.type === "text" && !(part as OcTextPart).ignored && (part as OcTextPart).text !== "") {
          blocks.push({ type: "text", text: String((part as OcTextPart).text) });
          textPartIndexes.push(partIndex);
        } else if (part.type === "file" && typeof part.mime === "string" && part.mime.startsWith("image/")) {
          blocks.push({ type: "image", mediaType: part.mime });
        }
      });
      if (blocks.length === 0) return;
      out.push({ role: "user", content: blocks, metadata: meta });
      bindings.push({ kind: "user", messageIndex, textPartIndexes });
      return;
    }
    if (role !== "assistant") return;
    const blocks: RuntimeContentBlock[] = [];
    const textPartIndexes: number[] = [];
    const reasoning: string[] = [];
    const results: Array<{ message: RuntimeMessage; binding: OcBinding }> = [];
    message.parts.forEach((part, partIndex) => {
      if (!isRecord(part)) return;
      if (part.type === "text") {
        blocks.push({ type: "text", text: String((part as OcTextPart).text ?? "") });
        textPartIndexes.push(partIndex);
      } else if (part.type === "reasoning") {
        reasoning.push(String(part.text ?? ""));
      } else if (isToolPart(part)) {
        const result = toolResultText(part);
        if (!result) return;
        blocks.push({ type: "tool_call", toolCallId: part.callID, toolName: part.tool, argumentsJson: isRecord(part.state.input) ? part.state.input : undefined });
        results.push({
          message: {
            role: "tool",
            content: [{ type: "tool_result", toolCallId: part.callID, toolName: part.tool, status: result.status, text: result.text }],
            metadata: { ...meta, ocPartId: String(part.id ?? "") },
          },
          binding: { kind: "tool", messageIndex, partIndex },
        });
      }
    });
    out.push({
      role: "assistant",
      content: blocks,
      metadata: { ...meta, ...(reasoning.length > 0 ? { reasoning } : {}), ...(message.info.summary ? { ocSummary: true } : {}) },
    });
    bindings.push({ kind: "assistant", messageIndex, textPartIndexes });
    for (const result of results) {
      out.push(result.message);
      bindings.push(result.binding);
    }
  });
  return { messages: out, bindings };
}

function textOf(message: RuntimeMessage | undefined): string[] {
  if (!message || typeof message.content === "string") return message ? [String(message.content)] : [];
  return message.content.flatMap((block) => (block.type === "text" || block.type === "tool_result" ? [block.text] : []));
}

/**
 * Apply canonical changes back into `messages` IN PLACE at the array level
 * (element replacement with clones), which is how OpenCode observes a
 * `experimental.chat.messages.transform` result. Returns the number of
 * replaced messages.
 */
export function applyOpenCodeChanges(
  messages: OcMessageWithParts[],
  decoded: OcDecoded,
  canonical: readonly RuntimeMessage[],
): number {
  const replacements = new Map<number, OcMessageWithParts>();
  const current = (index: number): OcMessageWithParts => replacements.get(index) ?? messages[index]!;

  decoded.bindings.forEach((binding, canonicalIndex) => {
    const before = textOf(decoded.messages[canonicalIndex]);
    const after = textOf(canonical[canonicalIndex]);
    if (after.length === before.length && after.every((text, i) => text === before[i])) return;
    const message = current(binding.messageIndex);
    const parts = message.parts.slice();

    if (binding.kind === "tool") {
      const part = parts[binding.partIndex] as OcToolPart;
      const nextText = after[0] ?? "";
      if (part.state.status === "completed") {
        if (part.state.time?.compacted) return;
        parts[binding.partIndex] = { ...part, state: { ...part.state, output: nextText } };
      } else if (part.state.status === "error") {
        const metadata = isRecord(part.state.metadata) ? part.state.metadata : undefined;
        parts[binding.partIndex] = metadata?.interrupted === true && typeof metadata.output === "string"
          ? { ...part, state: { ...part.state, metadata: { ...metadata, output: nextText } } }
          : { ...part, state: { ...part.state, error: nextText } };
      } else {
        return;
      }
    } else {
      if (after.length === 0 || binding.textPartIndexes.length === 0) return;
      // First text part carries the whole new text; the others are emptied (user
      // text parts with empty text are skipped by OpenCode, assistant ones are "").
      binding.textPartIndexes.forEach((partIndex, i) => {
        const part = parts[partIndex] as OcTextPart;
        const text = i === 0 ? after.join("\n") : "";
        if (part.text !== text) parts[partIndex] = { ...part, text };
      });
    }
    replacements.set(binding.messageIndex, { ...message, parts });
  });

  for (const [index, next] of replacements) messages[index] = next;
  return replacements.size;
}

/* ------------------------------------------------------------------ *
 * Eviction surface
 * ------------------------------------------------------------------ */

/** Stable id for an eviction target: `part:<id>` for tool results, `msg:<id>` otherwise. */
export function openCodeSurfaceId(message: RuntimeMessage): string {
  const meta = message.metadata ?? {};
  if (message.role === "tool" && typeof meta.ocPartId === "string" && meta.ocPartId) return `part:${meta.ocPartId}`;
  return `msg:${String(meta.ocMessageId ?? "")}`;
}

/** Canonical messages → surface entries; turn N starts at the Nth user message. */
export function openCodeSurfaceEntries(
  canonical: readonly RuntimeMessage[],
  evictedIds: ReadonlySet<string>,
): CanonicalSurfaceEntry[] {
  let turn = 0;
  return canonical.map((message) => {
    if (message.role === "user") turn += 1;
    const id = openCodeSurfaceId(message);
    const pruned = message.role === "tool" && textOf(message)[0] === OC_PRUNED_PLACEHOLDER;
    return {
      id,
      turn,
      message,
      checkpoint: message.metadata?.ocSummary === true,
      alreadyEvicted: evictedIds.has(id) || pruned,
    };
  });
}
