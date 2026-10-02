/**
 * TokenPilot runtime for OpenCode (v1 plugin hooks, 1.18.33):
 *
 *   experimental.chat.system.transform    stable prefix (shared stabilizer) + shared
 *                                          recovery protocol, per LLM request
 *   experimental.chat.messages.transform  per model step: durable eviction overlay →
 *                                          opt-in lifecycle eviction → request-time
 *                                          reduction (shared before-call path)
 *   recovery                               shared recovery MCP server (registered by
 *                                          install in opencode.json)
 *
 * OpenCode does not catch plugin exceptions (`Plugin.trigger`), so every hook body
 * is wrapped by `failOpen`, and host objects are only touched at the very end with
 * cloned replacements.
 */
import { stat } from "node:fs/promises";
import { configureStatePathResolver } from "@lightrsi/artifact-store";
import type { TaskStateEstimator } from "@lightrsi/eviction";
import type { SessionTaskRegistry } from "@lightrsi/history";
import {
  appendRecentTurnBinding,
  createStaticStatePathResolver,
  writeLatestSessionRef,
} from "@lightrsi/host-adapter";
import type { RuntimeMessage } from "@lightrsi/kernel";
import {
  applyCanonicalStablePrefix,
  createCanonicalEnvelope,
  recordCanonicalStability,
  runCanonicalBeforeCallReduction,
  withCanonicalRecoveryProtocol,
} from "../../shared/canonical/before-call.js";
import { evaluateEvictionReadiness } from "../../shared/canonical/config.js";
import { createCanonicalEstimator, runCanonicalSurfaceEviction } from "../../shared/canonical/eviction.js";
import { createFileLogger, failOpen, type AdapterLogger } from "../../shared/canonical/logger.js";
import { loadReductionMemo, saveReductionMemoIfDirty } from "../../shared/canonical/memo-store.js";
import { ReductionMemo, passSavedChars } from "../../shared/canonical/reduction.js";
import { applyOpenCodeChanges, decodeOpenCodeMessages, openCodeSurfaceEntries } from "./codec.js";
import {
  defaultTokenPilotOpenCodeConfigPath,
  loadTokenPilotOpenCodeConfig,
  type TokenPilotOpenCodeConfig,
} from "./config.js";
import type { OcHooks, OcMessageWithParts, OcModel } from "./opencode-types.js";
import { applyOverlay, loadOverlay, saveOverlay } from "./overlay.js";
import { initializeOpenCodeTokenPilotPreset, openCodeSupportsEviction } from "./preset.js";

export const OPENCODE_HOST_ID = "opencode";
export const OPENCODE_DISPLAY_NAME = "OpenCode";

export type OpenCodeRuntimeDependencies = {
  configPath?: string;
  loadConfig?: () => Promise<TokenPilotOpenCodeConfig>;
  supportsEviction?: boolean;
  createEstimator?: (config: TokenPilotOpenCodeConfig) => TaskStateEstimator | undefined;
  registryStore?: {
    load(sessionId: string): Promise<SessionTaskRegistry> | SessionTaskRegistry;
    persist(registry: SessionTaskRegistry, expectedVersion: number): Promise<void> | void;
  };
};

export class OpenCodeTokenPilotRuntime {
  config: TokenPilotOpenCodeConfig | undefined;
  readonly logger: AdapterLogger;
  private readonly memos = new Map<string, ReductionMemo>();
  private configStamp: string | undefined;
  private warnedUserTarget = false;
  private readonly deps: OpenCodeRuntimeDependencies & { configPath: string };

  constructor(deps: OpenCodeRuntimeDependencies = {}) {
    this.deps = { ...deps, configPath: deps.configPath ?? defaultTokenPilotOpenCodeConfigPath() };
    this.logger = createFileLogger({
      hostId: OPENCODE_HOST_ID,
      stateDir: () => this.config?.stateDir,
      debug: () => this.config?.logLevel === "debug",
    });
  }

  /** Session memo, loaded from stateDir on first use so OpenCode restarts keep the prefix stable. */
  async memoFor(stateDir: string, sessionId: string): Promise<ReductionMemo> {
    let memo = this.memos.get(sessionId);
    if (!memo) {
      memo = await loadReductionMemo(stateDir, sessionId);
      this.memos.set(sessionId, memo);
    }
    return memo;
  }

  /** Load config once, then again whenever tokenpilot.json changes (CLI mode switches apply live). */
  async ensureConfig(): Promise<TokenPilotOpenCodeConfig | undefined> {
    if (this.deps.loadConfig) {
      if (!this.config) this.bind(await this.deps.loadConfig());
      return this.config?.enabled ? this.config : undefined;
    }
    const stamp = await stat(this.deps.configPath).then((s) => `${s.mtimeMs}:${s.size}`).catch(() => "missing");
    if (!this.config || stamp !== this.configStamp) {
      this.bind(await loadTokenPilotOpenCodeConfig(this.deps.configPath));
      this.configStamp = stamp;
    }
    return this.config?.enabled ? this.config : undefined;
  }

  private bind(config: TokenPilotOpenCodeConfig): void {
    this.config = config;
    initializeOpenCodeTokenPilotPreset();
    configureStatePathResolver(createStaticStatePathResolver({
      hostId: OPENCODE_HOST_ID,
      displayName: OPENCODE_DISPLAY_NAME,
      stateDir: config.stateDir,
      namespaceDir: "tokenpilot",
    }));
  }

  onSystemTransform(input: { sessionID?: string; model?: OcModel }, output: { system: string[] }): Promise<void> {
    return failOpen(this.logger, "experimental.chat.system.transform", async () => {
      const config = await this.ensureConfig();
      if (!config || !Array.isArray(output?.system) || typeof output.system[0] !== "string") return;
      if (config.hooks.dynamicContextTarget === "user" && !this.warnedUserTarget) {
        this.warnedUserTarget = true;
        this.logger.warn("dynamicContextTarget=user is not supported on OpenCode 1.18.33 (messages.transform runs before system.transform); using developer");
      }
      const effective = { ...config, hooks: { ...config.hooks, dynamicContextTarget: "developer" as const } };
      const before = output.system[0];
      const stable = applyCanonicalStablePrefix(before, effective);
      const withRecovery = withCanonicalRecoveryProtocol(stable.instructions);
      if (withRecovery.text !== before) output.system[0] = withRecovery.text;
      if (stable.changed && input?.sessionID) {
        await recordCanonicalStability({
          config: effective,
          sessionId: input.sessionID,
          model: String(input.model?.id ?? ""),
          before,
          result: stable,
        }).catch((error) => this.logger.warn("stability snapshot failed", error));
      }
    }, undefined);
  }

  onMessagesTransform(output: { messages: OcMessageWithParts[] }): Promise<void> {
    return failOpen(this.logger, "experimental.chat.messages.transform", async () => {
      const config = await this.ensureConfig();
      const messages = output?.messages;
      if (!config || !Array.isArray(messages) || messages.length === 0) return;
      const sessionId = messages.map((m) => m?.info?.sessionID).find((id): id is string => typeof id === "string" && id.length > 0);
      if (!sessionId) return;
      const lastUser = [...messages].reverse().find((m) => m?.info?.role === "user");
      const model = String((lastUser?.info?.model as { modelID?: string } | undefined)?.modelID ?? "");

      const decoded = decodeOpenCodeMessages(messages);
      let canonical: RuntimeMessage[] = decoded.messages;

      let overlay = await loadOverlay(config.stateDir, sessionId);
      canonical = applyOverlay(canonical, overlay).messages;

      // Eviction is isolated: an estimator outage must not also disable reduction.
      try {
        const readiness = evaluateEvictionReadiness(config, this.deps.supportsEviction ?? openCodeSupportsEviction());
        if (readiness.active) {
          const estimator = (this.deps.createEstimator ?? createCanonicalEstimator)(config);
          if (estimator) {
            const entries = openCodeSurfaceEntries(canonical, new Set(Object.keys(overlay.entries)));
            const cycle = await runCanonicalSurfaceEviction({
              sessionId,
              entries,
              config,
              estimator,
              registryStore: this.deps.registryStore,
              apply: async (replacements) => {
                const at = new Date().toISOString();
                const next = { ...overlay, entries: { ...overlay.entries } };
                for (const replacement of replacements) next.entries[replacement.id] = { text: replacement.text, at };
                try {
                  await saveOverlay(config.stateDir, next);
                } catch (error) {
                  this.logger.warn("eviction overlay save failed", error);
                  return "deferred";
                }
                overlay = next;
                return "committed";
              },
            });
            if (cycle.status === "applied") {
              canonical = applyOverlay(canonical, overlay).messages;
              this.logger.info("eviction applied", { sessionId, targets: cycle.result.replacements.map((r) => r.id) });
            }
          }
        }
      } catch (error) {
        this.logger.warn("eviction failed open", error);
      }

      let savedChars = 0;
      let passSaved: Record<string, number> = {};
      if (config.modules.reduction) {
        const reduced = await runCanonicalBeforeCallReduction({
          envelope: createCanonicalEnvelope({ hostId: OPENCODE_HOST_ID, displayName: OPENCODE_DISPLAY_NAME, sessionId, model, messages: canonical }),
          config,
          memo: await this.memoFor(config.stateDir, sessionId),
        });
        canonical = reduced.messages;
        await saveReductionMemoIfDirty(config.stateDir, sessionId, await this.memoFor(config.stateDir, sessionId))
          .catch((error) => this.logger.warn("reduction memo save failed", error));
        savedChars = reduced.summary?.savedChars ?? 0;
        passSaved = passSavedChars(reduced.summary);
      }

      const changed = applyOpenCodeChanges(messages, decoded, canonical);
      await writeLatestSessionRef(config.stateDir, sessionId, new Date().toISOString());
      if (savedChars > 0) {
        await appendRecentTurnBinding(config.stateDir, { sessionId, updatedAt: new Date().toISOString(), model, reductionSavedChars: savedChars, reductionPassSavedChars: passSaved, changedMessages: changed })
          .catch((error) => this.logger.warn("turn binding failed", error));
      }
    }, undefined);
  }

  hooks(): OcHooks {
    return {
      "experimental.chat.system.transform": (input, output) => this.onSystemTransform(input, output),
      "experimental.chat.messages.transform": (_input, output) => this.onMessagesTransform(output),
      dispose: async () => {
        this.memos.clear();
      },
    };
  }
}
