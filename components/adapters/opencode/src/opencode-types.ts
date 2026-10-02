/**
 * Minimal structural mirrors of the OpenCode v1 plugin API this adapter touches.
 *
 * Like the DeepSeek Harness adapter, the adapter does not import the
 * host's packages: OpenCode loads it in-process (Bun) and passes objects that
 * match these shapes. Mirrored from the pinned `@opencode-ai/plugin@1.18.33`
 * (`dist/index.d.ts`, `Hooks`) and `@opencode-ai/sdk@1.18.33`
 * (`dist/gen/types.gen.d.ts`, `Message` / `Part`).
 */

export type OcTextPart = {
  id: string; sessionID: string; messageID: string; type: "text"; text: string;
  synthetic?: boolean; ignored?: boolean; [key: string]: unknown;
};
export type OcReasoningPart = { id: string; sessionID: string; messageID: string; type: "reasoning"; text: string; [key: string]: unknown };
export type OcFilePart = { id: string; sessionID: string; messageID: string; type: "file"; mime: string; url: string; filename?: string };
export type OcToolState =
  | { status: "pending" | "running"; input: Record<string, unknown>; [key: string]: unknown }
  | {
    status: "completed";
    input: Record<string, unknown>;
    output: string;
    title: string;
    metadata: Record<string, unknown>;
    time: { start: number; end: number; compacted?: number };
    attachments?: OcFilePart[];
  }
  | {
    status: "error";
    input: Record<string, unknown>;
    error: string;
    metadata?: Record<string, unknown>;
    time: { start: number; end: number };
  };
export type OcToolPart = {
  id: string; sessionID: string; messageID: string; type: "tool"; callID: string; tool: string; state: OcToolState;
  [key: string]: unknown;
};
export type OcOtherPart = { id: string; sessionID?: string; messageID?: string; type: string; [key: string]: unknown };
export type OcPart = OcTextPart | OcReasoningPart | OcFilePart | OcToolPart | OcOtherPart;

export type OcMessageInfo = {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  /** Assistant compaction summaries set this. */
  summary?: unknown;
  modelID?: string;
  providerID?: string;
  error?: unknown;
  [key: string]: unknown;
};

export type OcMessageWithParts = { info: OcMessageInfo; parts: OcPart[] };

export type OcModel = { id?: string; providerID?: string; [key: string]: unknown };

export type OcPluginInput = {
  directory: string;
  worktree: string;
  [key: string]: unknown;
};

export type OcHooks = {
  "experimental.chat.system.transform"?: (
    input: { sessionID?: string; model: OcModel },
    output: { system: string[] },
  ) => Promise<void>;
  "experimental.chat.messages.transform"?: (
    input: Record<string, never>,
    output: { messages: OcMessageWithParts[] },
  ) => Promise<void>;
  dispose?: () => Promise<void>;
};

export type OcPluginModule = {
  id: string;
  server: (input: OcPluginInput, options?: Record<string, unknown>) => Promise<OcHooks>;
};
