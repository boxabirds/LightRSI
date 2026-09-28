/**
 * TokenPilot runtime for pi. Each pi hook maps to one shared TokenPilot path:
 *
 *   session_start       load config, bind state roots, reset per-session caches
 *   before_agent_start  stable prefix (shared stabilizer over prompt sections) and
 *                       the shared recovery protocol as a stable prompt section
 *   context             request-time reduction (shared before-call pipeline)
 *   turn_end            opt-in lifecycle eviction → native `context_edit` entries
 *                       (committed before pi's threshold compaction check)
 *   memory_fault_recover  native tool over the shared recovery resolver
 *
 * Every hook fails open: on any error pi continues with its own, unmodified data
 * and the reason is logged to `<stateDir>/tokenpilot/adapter.log`.
 */
import { configureStatePathResolver } from "@lightrsi/artifact-store";
import type { TaskStateEstimator } from "@lightrsi/eviction";
import type { SessionTaskRegistry } from "@lightrsi/history";
import {
  appendRecentTurnBinding,
  createStaticStatePathResolver,
  writeLatestSessionRef,
} from "@lightrsi/host-adapter";
import type { RuntimeMessage } from "@lightrsi/kernel";
import { MEMORY_FAULT_RECOVER_TOOL_NAME, resolveMemoryFaultRecover } from "@lightrsi/mcp";
import { prependTextToContent, rewriteTextForStablePrefix } from "@lightrsi/stabilizer";
import {
  canonicalRecoveryProtocolText,
  createCanonicalEnvelope,
  recordCanonicalStability,
  runCanonicalBeforeCallReduction,
} from "../../shared/canonical/before-call.js";
import { evaluateEvictionReadiness } from "../../shared/canonical/config.js";
import {
  createCanonicalEstimator,
  runCanonicalSurfaceEviction,
  type CanonicalSurfaceEntry,
} from "../../shared/canonical/eviction.js";
import { createFileLogger, failOpen, type AdapterLogger } from "../../shared/canonical/logger.js";
import { ReductionMemo, passSavedChars } from "../../shared/canonical/reduction.js";
import {
  decodePiMessages,
  encodePiMessages,
  piProjectionToSurfaceEntries,
  piReplacementContent,
} from "./codec.js";
import { loadTokenPilotPiConfig, type TokenPilotPiConfig } from "./config.js";
import type {
  PiAgentMessage,
  PiContextEditDraft,
  PiEventMap,
  PiEventResultMap,
  PiExtensionContext,
  PiToolDefinition,
} from "./pi-types.js";
import { initializePiTokenPilotPreset, piSupportsEviction } from "./preset.js";

export const PI_HOST_ID = "pi";
export const PI_DISPLAY_NAME = "pi";
/** Trailing section that carries volatile prompt lines (developer target). */
export const PI_DYNAMIC_SECTION = "tokenpilot_dynamic";
/** Stable section that carries the shared recovery protocol. */
export const PI_RECOVERY_SECTION = "tokenpilot_recovery";

export type PiRuntimeDependencies = {
  loadConfig?: () => Promise<TokenPilotPiConfig>;
  supportsEviction?: boolean;
  createEstimator?: (config: TokenPilotPiConfig) => TaskStateEstimator | undefined;
  registryStore?: {
    load(sessionId: string): Promise<SessionTaskRegistry> | SessionTaskRegistry;
    persist(registry: SessionTaskRegistry, expectedVersion: number): Promise<void> | void;
  };
};

const RECOVERY_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    dataKey: { type: "string", description: "Archive dataKey from a prior [Tool payload trimmed] notice." },
    startLine: { type: "integer", minimum: 1, description: "Optional 1-based start line for partial recovery." },
    endLine: { type: "integer", minimum: 1, description: "Optional 1-based end line for partial recovery." },
  },
  required: ["dataKey"],
} as const;

export class PiTokenPilotRuntime {
  config: TokenPilotPiConfig | undefined;
  sessionId: string | undefined;
  readonly memo = new ReductionMemo();
  readonly logger: AdapterLogger;
  /** Volatile prompt lines to prepend request-locally to the first user message (user target). */
  pendingUserPrefix: string | undefined;
  private readonly deps: Required<Pick<PiRuntimeDependencies, "loadConfig" | "supportsEviction" | "createEstimator">>
    & Pick<PiRuntimeDependencies, "registryStore">;

  constructor(deps: PiRuntimeDependencies = {}) {
    this.deps = {
      loadConfig: deps.loadConfig ?? (() => loadTokenPilotPiConfig()),
      supportsEviction: deps.supportsEviction ?? piSupportsEviction(),
      createEstimator: deps.createEstimator ?? createCanonicalEstimator,
      registryStore: deps.registryStore,
    };
    this.logger = createFileLogger({
      hostId: PI_HOST_ID,
      stateDir: () => this.config?.stateDir,
      debug: () => this.config?.logLevel === "debug",
    });
  }

  private active(): TokenPilotPiConfig | undefined {
    return this.config?.enabled ? this.config : undefined;
  }

  private resolveSessionId(ctx: PiExtensionContext): string {
    const id = ctx.sessionManager?.getSessionId?.();
    return typeof id === "string" && id.trim() ? id.trim() : this.sessionId ?? "pi-unknown-session";
  }

  onSessionStart(_event: PiEventMap["session_start"], ctx: PiExtensionContext): Promise<void> {
    return failOpen(this.logger, "session_start", async () => {
      this.memo.clear();
      this.pendingUserPrefix = undefined;
      this.config = await this.deps.loadConfig();
      const config = this.config;
      initializePiTokenPilotPreset();
      configureStatePathResolver(createStaticStatePathResolver({
        hostId: PI_HOST_ID,
        displayName: PI_DISPLAY_NAME,
        stateDir: config.stateDir,
        namespaceDir: "tokenpilot",
      }));
      this.sessionId = this.resolveSessionId(ctx);
      if (!config.enabled) return;
      await writeLatestSessionRef(config.stateDir, this.sessionId, new Date().toISOString());
      this.logger.info("session_start", { sessionId: this.sessionId, cwd: ctx.cwd });
    }, undefined);
  }

  onSessionShutdown(): void {
    this.memo.clear();
    this.pendingUserPrefix = undefined;
  }

  onBeforeAgentStart(
    event: PiEventMap["before_agent_start"],
    ctx: PiExtensionContext,
  ): Promise<PiEventResultMap["before_agent_start"]> {
    return failOpen(this.logger, "before_agent_start", async () => {
      const config = this.active();
      if (!config) return undefined;
      const options = event.systemPromptOptions;
      const before = event.systemPrompt;
      const dynamicLines: string[] = [];

      if (config.modules.stabilizer) {
        const take = (text: string): string => {
          const rewrite = rewriteTextForStablePrefix(text);
          if (!rewrite.changed || !rewrite.dynamicContextText) return text;
          for (const line of rewrite.dynamicContextText.split("\n")) {
            if (line.trim() && !dynamicLines.includes(line)) dynamicLines.push(line);
          }
          return rewrite.forwardedText;
        };
        if (typeof options.appendSystemPrompt === "string" && options.appendSystemPrompt) {
          options.appendSystemPrompt = take(options.appendSystemPrompt);
        }
        for (const [name, text] of Object.entries(options.sections ?? {})) {
          if (name === PI_DYNAMIC_SECTION || name === PI_RECOVERY_SECTION || typeof text !== "string") continue;
          options.sections[name] = take(text);
        }
        for (const file of Array.isArray(options.contextFiles) ? options.contextFiles : []) {
          if (file && typeof file.content === "string") file.content = take(file.content);
        }
      }

      const dynamicText = dynamicLines.join("\n");
      this.pendingUserPrefix = undefined;
      if (dynamicText) {
        if (config.hooks.dynamicContextTarget === "developer") options.sections[PI_DYNAMIC_SECTION] = dynamicText;
        else this.pendingUserPrefix = dynamicText;
      }
      const recovery = canonicalRecoveryProtocolText();
      if (recovery) options.sections[PI_RECOVERY_SECTION] = recovery;

      if (dynamicText) {
        await recordCanonicalStability({
          config,
          sessionId: this.resolveSessionId(ctx),
          model: ctx.model?.id ?? "",
          before,
          result: {
            changed: true,
            instructions: typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : before,
            dynamicContextText: dynamicText,
          },
        }).catch((error) => this.logger.warn("stability snapshot failed", error));
      }
      return undefined;
    }, undefined);
  }

  onContext(event: PiEventMap["context"], ctx: PiExtensionContext): Promise<PiEventResultMap["context"]> {
    return failOpen(this.logger, "context", async () => {
      const config = this.active();
      if (!config || !Array.isArray(event.messages)) return undefined;
      const original = event.messages;
      let canonical: RuntimeMessage[] = decodePiMessages(original);

      if (this.pendingUserPrefix) {
        const userIndex = canonical.findIndex((message) => message.role === "user" && message.metadata?.lightrsiPassThrough !== true);
        if (userIndex >= 0) {
          const target = canonical[userIndex]!;
          canonical = canonical.slice();
          canonical[userIndex] = { ...target, content: prependTextToContent(target.content, this.pendingUserPrefix) as RuntimeMessage["content"] };
        }
      }

      const sessionId = this.resolveSessionId(ctx);
      if (config.modules.reduction) {
        const reduced = await runCanonicalBeforeCallReduction({
          envelope: createCanonicalEnvelope({
            hostId: PI_HOST_ID,
            displayName: PI_DISPLAY_NAME,
            sessionId,
            model: ctx.model?.id ?? "",
            messages: canonical,
          }),
          config,
          memo: this.memo,
        });
        canonical = reduced.messages;
        if ((reduced.summary?.savedChars ?? 0) > 0) {
          await appendRecentTurnBinding(config.stateDir, {
            sessionId,
            updatedAt: new Date().toISOString(),
            model: ctx.model?.id,
            reductionSavedChars: reduced.summary?.savedChars,
            reductionChangedBlocks: reduced.summary?.changedBlocks,
            memoReusedSegments: reduced.summary?.memoReusedSegments,
            reductionPassSavedChars: passSavedChars(reduced.summary),
          }).catch((error) => this.logger.warn("turn binding failed", error));
        }
      }

      const encoded = encodePiMessages(original, canonical);
      return encoded.some((message, index) => message !== original[index]) ? { messages: encoded } : undefined;
    }, undefined);
  }

  onTurnEnd(event: PiEventMap["turn_end"], ctx: PiExtensionContext): Promise<PiEventResultMap["turn_end"]> {
    return failOpen(this.logger, "turn_end", async () => {
      const config = this.active();
      if (!config) return undefined;
      const readiness = evaluateEvictionReadiness(config, this.deps.supportsEviction);
      if (!readiness.active) {
        this.logger.debug("eviction inactive", readiness);
        return undefined;
      }
      const estimator = this.deps.createEstimator(config);
      if (!estimator) return undefined;
      const projected = Array.isArray(event.context?.contextEntries) ? event.context.contextEntries : [];
      const entries: CanonicalSurfaceEntry[] = piProjectionToSurfaceEntries(projected);
      if (entries.length === 0) return undefined;
      const originals = new Map<string, PiAgentMessage | undefined>(
        projected.map((entry) => [entry?.sourceEntry?.id, entry?.messages?.[0]]),
      );
      const drafts: PiContextEditDraft[] = [];
      const sessionId = this.resolveSessionId(ctx);
      const cycle = await runCanonicalSurfaceEviction({
        sessionId,
        entries,
        config,
        estimator,
        registryStore: this.deps.registryStore,
        apply(replacements) {
          for (const replacement of replacements) {
            drafts.push({
              type: "context_edit",
              targetId: replacement.id,
              replacement: { content: piReplacementContent(originals.get(replacement.id), replacement.text) },
            });
          }
          return "committed";
        },
      });
      if (cycle.status !== "applied" || drafts.length === 0) return undefined;
      this.logger.info("eviction applied", {
        sessionId,
        targets: drafts.map((draft) => draft.targetId),
        savedChars: cycle.result.replacements.reduce((sum, r) => sum + Math.max(0, r.originalChars - r.text.length), 0),
      });
      return { entries: drafts };
    }, undefined);
  }

  recoveryTool(): PiToolDefinition {
    return {
      name: MEMORY_FAULT_RECOVER_TOOL_NAME,
      label: "TokenPilot recovery",
      description:
        "Recover archived content that was trimmed from a prior tool result. Use this internal tool with the provided dataKey instead of re-running the original tool.",
      parameters: RECOVERY_TOOL_SCHEMA as unknown as Record<string, unknown>,
      execute: async (_toolCallId, params) => {
        const dataKey = typeof params?.dataKey === "string" ? params.dataKey : "";
        try {
          const result = await resolveMemoryFaultRecover({
            dataKey,
            stateDir: this.config?.stateDir,
            startLine: typeof params?.startLine === "number" ? params.startLine : undefined,
            endLine: typeof params?.endLine === "number" ? params.endLine : undefined,
          });
          return { content: [{ type: "text", text: result.text }], details: result.details };
        } catch (error) {
          this.logger.warn("memory_fault_recover failed", error);
          return {
            content: [{ type: "text", text: `Recovery failed for dataKey: ${dataKey}` }],
            details: { error: "recovery_failed", dataKey },
          };
        }
      },
    };
  }
}
