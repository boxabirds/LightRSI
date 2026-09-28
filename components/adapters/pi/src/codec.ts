/**
 * pi transcript bridge: `AgentMessage[]` ↔ canonical `RuntimeMessage[]`.
 *
 * Decoding is lossless for everything TokenPilot may rewrite (tool-result text,
 * first-user-message text) and carries everything else by reference: encoding
 * starts from the original pi objects and clones only the messages whose
 * canonical text changed. An untouched envelope therefore round-trips to the
 * identical array of identical objects.
 *
 * Mapping (pi 0.87.1):
 *   user          → user        (text blocks; images → image blocks)
 *   assistant     → assistant   (text → text, toolCall → tool_call; thinking kept in metadata)
 *   toolResult    → tool        (one tool_result block; image parts counted in metadata)
 *   bashExecution, custom, branchSummary, compactionSummary, unknown
 *                 → user pass-through (visible text only; never rewritten)
 */
import type { RuntimeContentBlock, RuntimeMessage } from "@lightrsi/kernel";
import type { CanonicalSurfaceEntry } from "../../shared/canonical/eviction.js";
import type {
  PiAgentMessage,
  PiAssistantMessage,
  PiImageContent,
  PiProjectedSessionEntry,
  PiTextContent,
  PiToolResultMessage,
  PiUserMessage,
} from "./pi-types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOfParts(parts: unknown): string {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function passThroughText(message: Record<string, unknown>): string {
  switch (message.role) {
    case "bashExecution":
      return [`$ ${String(message.command ?? "")}`, String(message.output ?? "")].join("\n").trim();
    case "custom":
      return textOfParts(message.content);
    case "branchSummary":
    case "compactionSummary":
      return String(message.summary ?? "");
    default:
      return textOfParts(message.content);
  }
}

export function decodePiMessage(message: PiAgentMessage, index: number): RuntimeMessage {
  const meta = { piIndex: index, piRole: isRecord(message) ? String(message.role ?? "") : "" };
  if (!isRecord(message)) {
    return { role: "user", content: "", metadata: { ...meta, lightrsiPassThrough: true } };
  }
  if (message.role === "user") {
    const user = message as PiUserMessage;
    if (typeof user.content === "string") return { role: "user", content: user.content, metadata: meta };
    const blocks: RuntimeContentBlock[] = [];
    for (const part of Array.isArray(user.content) ? user.content : []) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string") blocks.push({ type: "text", text: part.text });
      else if (part.type === "image") blocks.push({ type: "image", mediaType: String((part as PiImageContent).mimeType ?? "") });
    }
    return { role: "user", content: blocks, metadata: meta };
  }
  if (message.role === "assistant") {
    const assistant = message as PiAssistantMessage;
    const blocks: RuntimeContentBlock[] = [];
    const reasoning: string[] = [];
    for (const part of Array.isArray(assistant.content) ? assistant.content : []) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string") blocks.push({ type: "text", text: part.text });
      else if (part.type === "toolCall" && typeof part.id === "string") {
        blocks.push({
          type: "tool_call",
          toolCallId: part.id,
          toolName: String(part.name ?? ""),
          argumentsJson: isRecord(part.arguments) ? part.arguments : undefined,
        });
      } else if (part.type === "thinking" && typeof part.thinking === "string") {
        reasoning.push(part.thinking);
      }
    }
    return { role: "assistant", content: blocks, metadata: { ...meta, ...(reasoning.length > 0 ? { reasoning } : {}) } };
  }
  if (message.role === "toolResult") {
    const result = message as PiToolResultMessage;
    const parts = Array.isArray(result.content) ? result.content : [];
    return {
      role: "tool",
      content: [{
        type: "tool_result",
        toolCallId: typeof result.toolCallId === "string" ? result.toolCallId : undefined,
        toolName: typeof result.toolName === "string" ? result.toolName : undefined,
        status: result.isError === true ? "error" : "success",
        text: textOfParts(parts),
      }],
      metadata: { ...meta, imageParts: parts.filter((part) => isRecord(part) && part.type === "image").length },
    };
  }
  return { role: "user", content: passThroughText(message), metadata: { ...meta, lightrsiPassThrough: true } };
}

export function decodePiMessages(messages: readonly PiAgentMessage[]): RuntimeMessage[] {
  return messages.map((message, index) => decodePiMessage(message, index));
}

function firstText(content: RuntimeMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .flatMap((block) => (block.type === "text" || block.type === "tool_result" ? [block.text] : []))
    .join("\n");
}

/**
 * Apply canonical changes back onto the original pi messages. Only tool-result
 * text and user text are writable; everything else is taken from `original`.
 */
export function encodePiMessages(
  original: readonly PiAgentMessage[],
  canonical: readonly RuntimeMessage[],
): PiAgentMessage[] {
  const decodedOriginal = decodePiMessages(original);
  return original.map((message, index) => {
    const next = canonical[index];
    const before = decodedOriginal[index];
    if (!next || !before || !isRecord(message) || next.metadata?.lightrsiPassThrough === true) return message;
    const nextText = firstText(next.content);
    if (nextText === firstText(before.content)) return message;

    if (message.role === "toolResult") {
      const result = message as PiToolResultMessage;
      const images = (Array.isArray(result.content) ? result.content : []).filter((part) => isRecord(part) && part.type !== "text");
      return { ...result, content: [{ type: "text", text: nextText } as PiTextContent, ...images] };
    }
    if (message.role === "user") {
      const user = message as PiUserMessage;
      if (typeof user.content === "string") return { ...user, content: nextText };
      const parts = Array.isArray(user.content) ? user.content : [];
      const images = parts.filter((part) => isRecord(part) && part.type !== "text");
      return { ...user, content: [{ type: "text", text: nextText } as PiTextContent, ...images] };
    }
    return message;
  });
}

/* ------------------------------------------------------------------ *
 * Session projection → canonical surface entries (eviction)
 * ------------------------------------------------------------------ */

const EVICTION_STUB_PREFIX = "[evicted:";

/**
 * Turn the projected branch (`turn_end.context.contextEntries`) into canonical
 * surface entries. Message entries become items; compaction, branch-summary and
 * custom-message entries become checkpoints; state-only entries are skipped.
 * Turn N starts at the Nth `user` message.
 */
export function piProjectionToSurfaceEntries(entries: readonly PiProjectedSessionEntry[]): CanonicalSurfaceEntry[] {
  const out: CanonicalSurfaceEntry[] = [];
  let turn = 0;
  entries.forEach((projected, entryIndex) => {
    const source = projected?.sourceEntry;
    if (!source || typeof source.id !== "string" || !Array.isArray(projected.messages)) return;
    if (projected.messages.length === 0) return;
    const isMessageEntry = source.type === "message" && projected.messages.length === 1;
    projected.messages.forEach((message, messageIndex) => {
      if (!isRecord(message) || message.role === "system") return;
      if (message.role === "user" && isMessageEntry) turn += 1;
      const canonical = decodePiMessage(message, entryIndex);
      const id = isMessageEntry ? source.id : `${source.id}#${messageIndex}`;
      out.push({
        id,
        turn,
        message: canonical,
        checkpoint: !isMessageEntry || canonical.metadata?.lightrsiPassThrough === true,
        alreadyEvicted: firstText(canonical.content).startsWith(EVICTION_STUB_PREFIX),
      });
    });
  });
  return out;
}

/** Replacement content for a `context_edit`, shaped for the target's role. */
export function piReplacementContent(
  message: PiAgentMessage | undefined,
  text: string,
): string | PiTextContent[] {
  if (isRecord(message) && message.role === "user" && typeof message.content === "string") return text;
  return [{ type: "text", text }];
}
