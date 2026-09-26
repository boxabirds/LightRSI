import {
  processCleanPromptIsInteractive,
  promptForCleanTasks,
  type CleanTaskPrompt,
} from "./clean-prompt.js";
import {
  renderCleanPlan,
  renderCleanReceipt,
  type CleanPlanView,
  type CleanReceiptView,
} from "./clean-renderer.js";

export interface CleanCommandBackend {
  analyze(sessionId: string): Promise<CleanPlanView>;
  readPlan(planId: string): Promise<CleanPlanView | undefined>;
  approve(planId: string, selectedTaskIds: string[]): Promise<CleanReceiptView>;
  readReceipt(planId: string): Promise<CleanReceiptView | undefined>;
  cancel(planId: string): Promise<CleanReceiptView>;
}

export type CleanCommandBackendResolver = (params: {
  hostId: string;
  sessionId?: string;
  pathOverrides?: {
    tokenPilotConfigPath?: string;
    hostConfigPath?: string;
    hostAuxConfigPath?: string;
  };
}) => Promise<CleanCommandBackend | undefined> | CleanCommandBackend | undefined;

let backendResolver: CleanCommandBackendResolver | undefined;

/** Common Host registration point. Host-specific construction remains outside the CLI controller. */
export function registerCleanCommandBackendResolver(resolver: CleanCommandBackendResolver | undefined): void {
  backendResolver = resolver;
}

export function resolveCleanCommandBackend(params: {
  hostId: string;
  sessionId?: string;
  pathOverrides?: {
    tokenPilotConfigPath?: string;
    hostConfigPath?: string;
    hostAuxConfigPath?: string;
  };
}): Promise<CleanCommandBackend | undefined> {
  return Promise.resolve(backendResolver?.(params));
}

type ParsedCleanArgs =
  | { action: "analyze"; sessionId?: string; requireTty: boolean }
  | { action: "approve"; planId: string; selectedTaskIds: string[]; requireTty: boolean }
  | { action: "status"; planId: string; requireTty: boolean }
  | { action: "cancel"; planId: string; requireTty: boolean };

export function formatCleanUsage(): string {
  return [
    "Usage:",
    "  lightrsi <host> clean [--session <session-id>]",
    "  lightrsi <host> clean --plan <plan-id> --select <task-id[,task-id...]>",
    "  lightrsi <host> clean --status <plan-id>",
    "  lightrsi <host> clean --cancel <plan-id>",
  ].join("\n");
}

function parseCleanArgs(inputArgs: string[]): ParsedCleanArgs {
  const requireTty = inputArgs[0] === "--require-tty";
  const args = requireTty ? inputArgs.slice(1) : inputArgs;
  if (args.length === 0) return { action: "analyze", requireTty };
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    throw new Error("clean_help");
  }

  const valueAt = (index: number, missingError: string): string => {
    const value = args[index]?.trim();
    if (!value || value.startsWith("--")) throw new Error(missingError);
    return value;
  };

  if (args.length === 2 && args[0] === "--session") {
    return { action: "analyze", sessionId: valueAt(1, "clean_session_id_missing"), requireTty };
  }
  if (args.length === 2 && args[0] === "--status") {
    return { action: "status", planId: valueAt(1, "clean_plan_id_missing"), requireTty };
  }
  if (args.length === 2 && args[0] === "--cancel") {
    return { action: "cancel", planId: valueAt(1, "clean_plan_id_missing"), requireTty };
  }
  if (args.length === 4 && args[0] === "--plan" && args[2] === "--select") {
    const selectedTaskIds = valueAt(3, "clean_selection_missing").split(",").map((taskId) => taskId.trim());
    if (selectedTaskIds.some((taskId) => !taskId)) throw new Error("clean_selection_malformed");
    return {
      action: "approve",
      planId: valueAt(1, "clean_plan_id_missing"),
      selectedTaskIds,
      requireTty,
    };
  }
  throw new Error("clean_argument_syntax");
}

export function cleanSessionIdFromArgs(args: string[]): string | undefined {
  const parsed = parseCleanArgs(args);
  return parsed.action === "analyze" ? parsed.sessionId : undefined;
}

/**
 * True when the parsed command analyzes a live session and therefore has to be
 * bound to one. --plan/--status/--cancel address a stored plan by id instead,
 * so they never need a session.
 */
export function cleanCommandRequiresSessionId(args: string[]): boolean {
  try {
    return parseCleanArgs(args).action === "analyze";
  } catch {
    return false;
  }
}

/**
 * Shown instead of silently analyzing whichever session wrote state most
 * recently. With several Host windows open that guess is wrong as often as it
 * is right, and cleaning the wrong conversation is not recoverable from the
 * CLI, so the entry point refuses to choose.
 */
export function formatCleanSessionRequired(params: {
  hostId: string;
  recentSessionId?: string;
}): string {
  const lines = [
    "Context Cleaner needs an explicit session id.",
    "",
    "The entry point has to be bound to the session you are actually in, so it",
    "never guesses which conversation to clean.",
    "",
    `Inside ${params.hostId}, run the Cleaner skill: it prints the plan together`,
    "with the exact command for that session.",
    "",
    "Or pass the session yourself:",
    `  lightrsi ${params.hostId} clean --session <session-id>`,
  ];
  if (params.recentSessionId) {
    lines.push(
      "",
      `Most recently active session on this host: ${params.recentSessionId}`,
      "Shown for reference only. Confirm it is the session you are in before using it.",
    );
  }
  return lines.join("\n");
}

function validateSelection(plan: CleanPlanView, selectedTaskIds: string[]): string[] {
  if (selectedTaskIds.length === 0) throw new Error("clean_selection_empty");
  if (new Set(selectedTaskIds).size !== selectedTaskIds.length) throw new Error("clean_selection_duplicate_task");
  const tasks = new Map(plan.tasks.map((task) => [task.taskId, task]));
  for (const taskId of selectedTaskIds) {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`clean_selection_unknown_task:${taskId}`);
    if (!task.selectable) throw new Error(`clean_selection_task_protected:${taskId}`);
  }
  return selectedTaskIds;
}

async function approveSelection(
  backend: CleanCommandBackend,
  plan: CleanPlanView,
  selectedTaskIds: string[],
): Promise<string> {
  const selected = validateSelection(plan, selectedTaskIds);
  return renderCleanReceipt(await backend.approve(plan.planId, selected));
}

/**
 * Claude Code runs a skill's command through its Bash tool, which gets no
 * pseudo-terminal, so the arrow-key selector cannot open there. The plan is
 * still worth showing; what the user needs alongside it is the one command
 * that does reach a real terminal. Exiting returns to the same shell; the
 * session id is carried explicitly so the selector binds to this conversation,
 * and Claude Code can then resume that exact session.
 *
 * --require-tty has to lead: parseCleanArgs only accepts it in first position.
 */
function interactiveLaunchHint(plan: CleanPlanView): string | undefined {
  if (plan.hostId !== "claude-code") return undefined;
  return [
    "Interactive selection in this same terminal:",
    "  1. In Claude Code, run /exit to return to this terminal",
    `  2. Run: lightrsi claude-code clean --require-tty --session ${plan.sessionId}`,
    "  3. Move with Up/Down, toggle with Space, submit with Enter, cancel with q",
    `  4. Resume the same session: claude --resume ${plan.sessionId}`,
    "",
    "Submitting only schedules the selection; it is applied on the next Claude Code request.",
  ].join("\n");
}

function renderNonInteractiveAnalysis(plan: CleanPlanView, rendered: string): string {
  const selectableTasks = plan.tasks.filter((task) => task.selectable);
  const choices = selectableTasks.length === 0
    ? "No selectable tasks are available; no changes were applied."
    : [
      "Selectable tasks:",
      "None selected by default.",
      ...selectableTasks.map((task, index) => `${index + 1}. ${task.taskId} - ${task.label}`),
      "Choose task IDs explicitly after reviewing this plan.",
    ].join("\n");
  const nextCommand = selectableTasks.length === 0
    ? ""
    : ` Apply with --plan ${plan.planId} --select <task-id[,task-id...]>`;
  const launch = selectableTasks.length === 0 ? undefined : interactiveLaunchHint(plan);
  const base = `${rendered}\n\n${choices}\n\nAnalysis only (non-interactive).${nextCommand}`;
  return launch ? `${base}\n\n${launch}` : base;
}

export async function handleCleanCommand(params: {
  args: string[];
  sessionId?: string;
  backend: CleanCommandBackend;
  interactive?: boolean;
  prompt?: CleanTaskPrompt;
}): Promise<{ text: string }> {
  let parsed: ParsedCleanArgs;
  try {
    parsed = parseCleanArgs(params.args);
  } catch (error) {
    if (error instanceof Error && error.message === "clean_help") return { text: formatCleanUsage() };
    throw error;
  }

  if (parsed.action === "status") {
    const receipt = await params.backend.readReceipt(parsed.planId);
    return { text: receipt ? renderCleanReceipt(receipt) : `Context clean receipt not found: ${parsed.planId}` };
  }
  if (parsed.action === "cancel") return { text: renderCleanReceipt(await params.backend.cancel(parsed.planId)) };
  if (parsed.action === "approve") {
    const plan = await params.backend.readPlan(parsed.planId);
    if (!plan) throw new Error(`clean_plan_missing:${parsed.planId}`);
    return { text: await approveSelection(params.backend, plan, parsed.selectedTaskIds) };
  }

  const interactive = params.interactive ?? processCleanPromptIsInteractive();
  if (parsed.requireTty && !interactive) throw new Error("clean_interactive_tty_required");
  const sessionId = params.sessionId?.trim() || parsed.sessionId;
  if (!sessionId) throw new Error("clean_session_id_missing");
  const plan = await params.backend.analyze(sessionId);
  const rendered = renderCleanPlan(plan);
  if (!interactive) {
    return { text: renderNonInteractiveAnalysis(plan, rendered) };
  }
  const terminalPromptOwnsPlanOutput = params.prompt === undefined
    && processCleanPromptIsInteractive();
  const resultText = (summary: string, transcript?: string) => transcript
    ? `${transcript}\n\n${summary}`
    : terminalPromptOwnsPlanOutput
      ? summary
      : `${rendered}\n\n${summary}`;
  const selection = await (params.prompt ?? promptForCleanTasks)(plan);
  if (selection.action === "cancel") {
    const receipt = renderCleanReceipt(await params.backend.cancel(plan.planId));
    const unavailable = selection.reason === "windows_console_buffer_unavailable"
      ? "Windows Cleaner screen buffer unavailable; the plan was cancelled.\n\n"
      : "";
    return { text: resultText(`${unavailable}${receipt}`, selection.transcript) };
  }
  if (selection.action === "interrupt") {
    await params.backend.cancel(plan.planId);
    throw new Error("clean_selection_interrupted");
  }
  if (selection.selectedTaskIds.length === 0) {
    return {
      text: resultText("No tasks selected; no changes were applied.", selection.transcript),
    };
  }
  return {
    text: resultText(
      await approveSelection(params.backend, plan, selection.selectedTaskIds),
      selection.transcript,
    ),
  };
}
