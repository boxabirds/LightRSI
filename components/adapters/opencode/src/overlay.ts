/**
 * Durable eviction overlay for OpenCode.
 *
 * OpenCode 1.18.33 gives plugins no persistent part-edit hook, so lifecycle
 * eviction is applied request-locally in `experimental.chat.messages.transform`
 * (the Claude Code adapter's overlay approach). The set of evicted targets and
 * their replacement text is stored per session so every later request re-applies
 * exactly the same bytes: eviction decisions are durable and the outgoing
 * history stays prefix-stable.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFileAtomic } from "@lightrsi/host-adapter";
import type { RuntimeMessage } from "@lightrsi/kernel";
import { openCodeSurfaceId } from "./codec.js";

export type OverlayEntry = { text: string; at: string };
export type EvictionOverlay = { version: 1; sessionId: string; entries: Record<string, OverlayEntry> };

export function overlayPath(stateDir: string, sessionId: string): string {
  return join(stateDir, "tokenpilot", "eviction-overlay", `${encodeURIComponent(sessionId)}.json`);
}

export async function loadOverlay(stateDir: string, sessionId: string): Promise<EvictionOverlay> {
  try {
    const parsed = JSON.parse(await readFile(overlayPath(stateDir, sessionId), "utf8")) as EvictionOverlay;
    if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") return parsed;
  } catch {
    // Missing or unreadable overlay: start empty (nothing is evicted).
  }
  return { version: 1, sessionId, entries: {} };
}

export async function saveOverlay(stateDir: string, overlay: EvictionOverlay): Promise<void> {
  await writeJsonFileAtomic(overlayPath(stateDir, overlay.sessionId), overlay);
}

/** Replace overlaid messages' text with their stored replacement (tool_call blocks are kept). */
export function applyOverlay(messages: readonly RuntimeMessage[], overlay: EvictionOverlay): { messages: RuntimeMessage[]; applied: number } {
  let applied = 0;
  const next = messages.map((message) => {
    const entry = overlay.entries[openCodeSurfaceId(message)];
    if (!entry || !Array.isArray(message.content)) return message;
    applied += 1;
    if (message.role === "tool") {
      return {
        ...message,
        content: message.content.map((block) => (block.type === "tool_result" ? { ...block, text: entry.text } : block)),
      };
    }
    const kept = message.content.filter((block) => block.type !== "text");
    return { ...message, content: [{ type: "text" as const, text: entry.text }, ...kept] };
  });
  return { messages: next, applied };
}
