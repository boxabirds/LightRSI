/**
 * Minimal structural mirrors of the pi extension API this adapter touches.
 *
 * Following the DeepSeek Harness adapter's precedent (`deepseek-harness/src/types.ts`),
 * the adapter does not import pi's packages: pi loads it in-process and passes
 * real objects that match these shapes. Every field is mirrored from the pinned
 * `@earendil-works/pi-coding-agent@0.87.1` declarations:
 *   - ExtensionAPI / events / results   dist/core/extensions/types.d.ts
 *   - SessionEntry / ContextEditEntry   dist/core/session-manager.d.ts
 *   - AgentMessage content types        @earendil-works/pi-ai dist/types.d.ts
 *   - custom message roles              dist/core/messages.d.ts
 * If pi changes one of these shapes, this file is the single place to update.
 */

export type PiTextContent = { type: "text"; text: string; textSignature?: string };
export type PiThinkingContent = { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean };
export type PiImageContent = { type: "image"; data: string; mimeType: string };
export type PiToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export type PiUserMessage = { role: "user"; content: string | (PiTextContent | PiImageContent)[]; timestamp: number };
export type PiAssistantMessage = {
  role: "assistant";
  content: (PiTextContent | PiThinkingContent | PiToolCall)[];
  model?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  timestamp: number;
  [key: string]: unknown;
};
export type PiToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (PiTextContent | PiImageContent)[];
  isError: boolean;
  timestamp: number;
  [key: string]: unknown;
};
/** bashExecution, custom, branchSummary, compactionSummary, and future roles. */
export type PiOtherMessage = { role: string; [key: string]: unknown };

export type PiAgentMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage | PiOtherMessage;

export type PiSessionEntry = {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: PiAgentMessage;
  targetId?: string;
  customType?: string;
  [key: string]: unknown;
};

export type PiProjectedSessionEntry = {
  sourceEntry: PiSessionEntry;
  messages: PiAgentMessage[];
};

export type PiReadonlySessionManager = {
  getCwd(): string;
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getBranch(fromId?: string): PiSessionEntry[];
};

export type PiExtensionContext = {
  cwd: string;
  mode?: string;
  sessionManager: PiReadonlySessionManager;
  model?: { id?: string; provider?: string } | undefined;
  getSystemPrompt?(): string;
};

export type PiContextEditDraft = {
  type: "context_edit";
  targetId: string;
  replacement: { content: string | (PiTextContent | PiImageContent)[] } | null;
};

export type PiBoundaryState = {
  entries: unknown[];
  continue: boolean;
  context: { contextEntries: PiProjectedSessionEntry[] };
};

export type PiEventMap = {
  session_start: { type: "session_start"; reason: string };
  session_shutdown: { type: "session_shutdown"; reason: string };
  before_agent_start: {
    type: "before_agent_start";
    prompt: string;
    readonly systemPrompt: string;
    systemPromptOptions: {
      appendSystemPrompt: string;
      sections: Record<string, string>;
      contextFiles: Array<{ path: string; content: string }>;
      [key: string]: unknown;
    };
  };
  context: { type: "context"; messages: PiAgentMessage[] };
  turn_start: { type: "turn_start"; turnIndex: number; timestamp: number };
  turn_end: PiBoundaryState & { type: "turn_end"; turnIndex: number };
  message_end: { type: "message_end"; message: PiAgentMessage };
};

export type PiEventResultMap = {
  session_start: void;
  session_shutdown: void;
  before_agent_start: { message?: { customType: string; content: string; display: boolean }; systemPrompt?: string } | void;
  context: { messages?: PiAgentMessage[] } | void;
  turn_start: void;
  turn_end: { entries?: PiContextEditDraft[]; continue?: boolean } | void;
  message_end: void;
};

export type PiToolResult = {
  content: PiTextContent[];
  details: unknown;
};

export type PiToolDefinition = {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: PiExtensionContext,
  ): Promise<PiToolResult>;
};

export type PiExtensionAPI = {
  on<K extends keyof PiEventMap>(
    event: K,
    handler: (event: PiEventMap[K], ctx: PiExtensionContext) => Promise<PiEventResultMap[K]> | PiEventResultMap[K],
  ): unknown;
  registerTool(tool: PiToolDefinition): void;
};
