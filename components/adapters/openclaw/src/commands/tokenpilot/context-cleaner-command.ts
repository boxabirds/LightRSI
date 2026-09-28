import {
  createApiContextCleanRecommendationProvider,
  type ContextCleanPlan,
  type ContextCleanReceipt,
  type ContextCleanRecommendationProvider,
} from "@lightrsi/cleaner";
import type { JsonModelClient } from "@lightrsi/runtime-core";

import { createOpenClawCleanerControlService } from "../../context-cleaner/index.js";
import { ensureOpenClawCleanerTaskRegistry } from "../../context-cleaner/task-registry-bootstrap.js";
import { normalizeConfig } from "../../context-stack/integration/config-normalize.js";
import type { NormalizedPluginRuntimeConfig } from "../../context-stack/integration/config-types.js";
import { resolveSessionIdFromCommandScope } from "../../session/command-scope-map.js";
import { renderOpenClawCleanPlan } from "./context-cleaner-renderer.js";
import { pluginConfigRecord } from "./host-config-adapter.js";

type OpenClawCleanBackend = {
  stateDir: string;
  analyze(sessionId: string): Promise<ContextCleanPlan>;
  readPlan(planId: string): Promise<ContextCleanPlan | undefined>;
  approve(planId: string, selectedTaskIds: string[]): Promise<ContextCleanReceipt>;
  readReceipt(planId: string): Promise<ContextCleanReceipt | undefined>;
  cancel(planId: string): Promise<ContextCleanReceipt>;
};

type ParsedCleanArgs = {
  sessionId?: string;
  planId?: string;
  selectedTaskIds?: string[];
  status: boolean;
  cancel: boolean;
  help: boolean;
};

export function loadOpenClawContextCleanerConfig(
  api: any,
): Record<string, unknown> | Promise<Record<string, unknown>> {
  const currentConfig = api?.config;
  if (currentConfig && typeof currentConfig === "object" && !Array.isArray(currentConfig)) {
    return currentConfig as Record<string, unknown>;
  }

  const legacyConfigApi = api?.runtime?.config;
  if (typeof legacyConfigApi?.loadConfig === "function") {
    return legacyConfigApi.loadConfig.call(legacyConfigApi) as
      | Record<string, unknown>
      | Promise<Record<string, unknown>>;
  }

  throw new Error("clean_config_unavailable");
}

export function formatOpenClawCleanUsage(): string {
  return [
    "Context Cleaner:",
    "  /lightrsi clean [--session <session-id>]",
    "  /lightrsi clean --plan <plan-id> --select <task-id[,task-id...>]",
    "  /lightrsi clean --status <plan-id>",
    "  /lightrsi clean --cancel <plan-id>",
    "The first command only analyzes. Cleaning requires an explicit task selection.",
    "Selection schedules cleaning for the next ordinary OpenClaw request.",
    "Arrow-key selection runs in a terminal:",
    "  lightrsi openclaw clean --require-tty --session <session-id>",
  ].join("\n");
}

function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function quotePowerShellArgument(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function formatOpenClawInteractiveLaunch(plan: ContextCleanPlan): string | undefined {
  if (!plan.tasks.some((task) => task.selectable)) return undefined;
  const refusalReason = /[\u0000-\u001f\u007f-\u009f]/u.test(plan.sessionId)
    ? "contains control characters"
    : plan.sessionId.startsWith("--") ? "starts with a reserved option prefix" : undefined;
  if (refusalReason) {
    return [
      `Interactive terminal command unavailable: the session id ${refusalReason}.`,
      "Use the native /lightrsi clean --plan ... --select ... command shown above.",
    ].join("\n");
  }
  const commandPrefix = "lightrsi openclaw clean --require-tty --session";
  if (/^[A-Za-z0-9_@+=:,./-]+$/u.test(plan.sessionId)) {
    return [
      "Interactive selection in this terminal:",
      "  1. Return to the shell that launched OpenClaw",
      `  2. Run: ${commandPrefix} ${plan.sessionId}`,
      "  3. Move with Up/Down, toggle with Space, submit with Enter, cancel with q",
      "  4. Return to OpenClaw; a submitted plan runs on the next ordinary request",
      "",
      "The explicit session id binds the selector to this conversation; no recent-session guess is used.",
    ].join("\n");
  }
  const posixArgument = quotePosixShellArgument(plan.sessionId);
  const powerShellArgument = quotePowerShellArgument(plan.sessionId);
  const commandLines = posixArgument === powerShellArgument
    ? [`  2. Run (POSIX shell or PowerShell): ${commandPrefix} ${posixArgument}`]
    : [
        `  2. POSIX shell: ${commandPrefix} ${posixArgument}`,
        `     PowerShell: ${commandPrefix} ${powerShellArgument}`,
      ];
  return [
    "Interactive selection in this terminal:",
    "  1. Return to the shell that launched OpenClaw",
    ...commandLines,
    "  3. Move with Up/Down, toggle with Space, submit with Enter, cancel with q",
    "  4. Return to OpenClaw; a submitted plan runs on the next ordinary request",
    "",
    "The explicit session id binds the selector to this conversation; no recent-session guess is used.",
  ].join("\n");
}

function parseCleanArgs(rawArgs: string): ParsedCleanArgs {
  const args = rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
  const parsed: ParsedCleanArgs = { status: false, cancel: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--session" || argument === "--plan" || argument === "--select") {
      const value = args[++index]?.trim();
      if (!value || value.startsWith("--")) throw new Error(`clean_${argument.slice(2)}_missing`);
      if (argument === "--session") {
        if (parsed.sessionId) throw new Error("clean_session_duplicate");
        parsed.sessionId = value;
      } else if (argument === "--plan") {
        if (parsed.planId) throw new Error("clean_plan_duplicate");
        parsed.planId = value;
      } else {
        if (parsed.selectedTaskIds) throw new Error("clean_selection_duplicate_argument");
        parsed.selectedTaskIds = value.split(",").map((taskId) => taskId.trim());
        if (parsed.selectedTaskIds.some((id) => !id)) throw new Error("clean_selection_malformed");
      }
      continue;
    }
    if (argument === "--status" || argument === "--cancel") {
      const field = argument === "--status" ? "status" : "cancel";
      if (parsed[field]) throw new Error(`clean_${field}_duplicate`);
      parsed[field] = true;
      const possiblePlanId = args[index + 1]?.trim();
      if (possiblePlanId && !possiblePlanId.startsWith("--")) {
        index += 1;
        if (parsed.planId && parsed.planId !== possiblePlanId) throw new Error("clean_plan_conflict");
        parsed.planId = possiblePlanId;
      }
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    throw new Error(`clean_argument_unknown:${argument}`);
  }

  if (parsed.help && args.length > 1) throw new Error("clean_help_conflict");
  const actions = Number(parsed.selectedTaskIds !== undefined) + Number(parsed.status) + Number(parsed.cancel);
  if (actions > 1) throw new Error("clean_action_conflict");
  if (actions > 0 && !parsed.planId) throw new Error("clean_plan_missing");
  if (parsed.planId && actions === 0) throw new Error("clean_action_missing");
  if (parsed.planId && parsed.sessionId) throw new Error("clean_session_plan_conflict");
  return parsed;
}

function count(tokens: number | null, chars: number): string {
  return tokens === null ? `${chars} chars` : `${tokens} tok`;
}

function renderReceipt(receipt: ContextCleanReceipt): string {
  const receiptCount = (tokens: number | null, chars: number): string => count(
    receipt.tokenCountMode === "chars_only" ? null : tokens,
    chars,
  );
  const lines = [
    `Context clean ${receipt.status}: ${receipt.planId}`,
    `Selected tasks: ${receipt.selectedTaskIds.length > 0 ? receipt.selectedTaskIds.join(", ") : "(none)"}`,
    `Estimated savings: ${receiptCount(receipt.estimatedSavedTokens, receipt.estimatedSavedChars)}`,
  ];
  if (receipt.status === "applied") {
    lines.push(`Applied savings: ${receiptCount(receipt.appliedSavedTokens, receipt.appliedSavedChars)}`);
    lines.push(`Fallback count: ${receipt.fallbackUsed ? 1 : 0}`);
    lines.push("Apply timing: next Host request (completed).");
  } else if (receipt.status === "scheduled") {
    lines.push(`Scheduled savings: ${receiptCount(receipt.estimatedSavedTokens, receipt.estimatedSavedChars)}`);
    lines.push("Applied savings: not applied");
    lines.push(`Fallback count: ${receipt.fallbackUsed ? 1 : 0}`);
    lines.push("Apply timing: next Host request.");
    lines.push("Send your next ordinary OpenClaw message, then query --status.");
  } else {
    lines.push(`Fallback count: ${receipt.fallbackUsed ? 1 : 0}`);
  }
  if (receipt.deferredTaskIds.length > 0) lines.push(`Deferred tasks: ${receipt.deferredTaskIds.join(", ")}`);
  if (receipt.reasons.length > 0) lines.push(`Reasons: ${receipt.reasons.join(", ")}`);
  return lines.join("\n");
}

export function createOpenClawCleanRecommendationProvider(
  normalized: NormalizedPluginRuntimeConfig,
  modelClient?: JsonModelClient,
): ContextCleanRecommendationProvider | undefined {
  const config = {
    baseUrl: normalized.taskStateEstimator.baseUrl,
    apiKey: normalized.taskStateEstimator.apiKey,
    model: normalized.taskStateEstimator.model,
    requestTimeoutMs: normalized.taskStateEstimator.requestTimeoutMs,
  };
  if (modelClient) {
    return createApiContextCleanRecommendationProvider(config, () => modelClient);
  }
  return normalized.taskStateEstimator.enabled
    ? createApiContextCleanRecommendationProvider(config)
    : undefined;
}

export function createOpenClawCleanBackend(
  currentConfig: Record<string, unknown>,
  logger?: { warn?: (message: string) => void },
  modelClient?: JsonModelClient,
): OpenClawCleanBackend {
  const normalized = normalizeConfig(pluginConfigRecord(currentConfig));
  const stateDir = normalized.stateDir.trim();
  if (!stateDir) throw new Error("clean_state_dir_missing");
  const service = createOpenClawCleanerControlService({
    stateDir,
    replacementMode: normalized.eviction.replacementMode ?? "pointer_stub",
    recommendationProvider: createOpenClawCleanRecommendationProvider(normalized, modelClient),
    beforeAnalyze: (sessionId) => ensureOpenClawCleanerTaskRegistry({
      currentConfig, normalized, sessionId, logger, modelClient,
    }).then(() => undefined),
  });
  return { stateDir, ...service };
}

function directSessionId(ctx: any): string | undefined {
  const candidates = [ctx?.sessionId, ctx?.session_id, ctx?.ctx?.SessionId, ctx?.ctx?.sessionId];
  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (value && !value.startsWith("agent:")) return value;
  }
  return undefined;
}

export async function handleOpenClawContextCleanCommand(params: {
  ctx: any;
  rawArgs: string;
  backend: OpenClawCleanBackend;
}): Promise<{ text: string }> {
  const parsed = parseCleanArgs(params.rawArgs);
  if (parsed.help) return { text: formatOpenClawCleanUsage() };
  if (parsed.planId) {
    if (parsed.status) {
      const receipt = await params.backend.readReceipt(parsed.planId);
      return { text: receipt ? renderReceipt(receipt) : `Context clean receipt not found: ${parsed.planId}` };
    }
    if (parsed.cancel) return { text: renderReceipt(await params.backend.cancel(parsed.planId)) };
    return { text: renderReceipt(await params.backend.approve(parsed.planId, parsed.selectedTaskIds!)) };
  }

  const sessionId = parsed.sessionId
    ?? resolveSessionIdFromCommandScope(params.backend.stateDir, params.ctx, params.ctx?.commandBody)
    ?? directSessionId(params.ctx);
  if (!sessionId) throw new Error("clean_session_missing; use --session <session-id>");
  const plan = await params.backend.analyze(sessionId);
  const rendered = renderOpenClawCleanPlan(plan);
  const interactiveLaunch = formatOpenClawInteractiveLaunch(plan);
  return { text: interactiveLaunch ? `${rendered}\n\n${interactiveLaunch}` : rendered };
}

export function createOpenClawContextCleanerCommandHandler(params: {
  loadConfig(): Promise<Record<string, unknown>> | Record<string, unknown>;
  createBackend?: (currentConfig: Record<string, unknown>) => OpenClawCleanBackend;
  logger?: { warn?: (message: string) => void };
  createModelClient?: (ctx: any) => JsonModelClient | undefined;
}) {
  return async (ctx: any, rawArgs: string): Promise<{ text: string }> => {
    if (["--help", "-h"].includes(rawArgs.trim())) {
      return { text: formatOpenClawCleanUsage() };
    }
    try {
      const currentConfig = await params.loadConfig();
      const backend = params.createBackend
        ? params.createBackend(currentConfig)
        : createOpenClawCleanBackend(
            currentConfig,
            params.logger,
            params.createModelClient?.(ctx),
          );
      return await handleOpenClawContextCleanCommand({ ctx, rawArgs, backend });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { text: `Context clean error: ${message}\n\n${formatOpenClawCleanUsage()}` };
    }
  };
}
