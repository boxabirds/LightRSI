import type { ProductCommandResult } from "@lightrsi/host-adapter";
import {
  readCliContextState,
  updateCliContextState,
} from "./context-store.js";
import type { CliHostPathOverrides } from "./context-store.js";
import { CLI_HOSTS, parseCliHostId, resolveLatestCliReportHost, type CliHostId } from "./hosts/registry.js";
import { createCliHostRuntime, registerBuiltInCliHostProducts } from "./hosts/factory.js";
import { handleStandaloneVisualCommandWithSelection } from "./hosts/visual.js";
import {
  cleanCommandRequiresSessionId,
  cleanSessionIdFromArgs,
  formatCleanSessionRequired,
  formatCleanUsage,
  handleCleanCommand,
  resolveCleanCommandBackend,
} from "./clean.js";
import { formatCliUsage } from "./usage.js";

registerBuiltInCliHostProducts();

type HostTarget = {
  host: CliHostId;
  sessionId?: string;
  pathOverrides?: CliHostPathOverrides;
};

function currentEnvPathOverrides(host: CliHostId): CliHostPathOverrides | undefined {
  if (host === "codex") {
    const tokenPilotConfigPath = process.env.TOKENPILOT_CODEX_CONFIG?.trim();
    const hostConfigPath = process.env.CODEX_CONFIG_PATH?.trim();
    const hostAuxConfigPath = process.env.CODEX_HOOKS_CONFIG_PATH?.trim();
    return tokenPilotConfigPath || hostConfigPath || hostAuxConfigPath
      ? { tokenPilotConfigPath, hostConfigPath, hostAuxConfigPath }
      : undefined;
  }
  if (host === "claude-code") {
    const tokenPilotConfigPath = process.env.TOKENPILOT_CLAUDE_CODE_CONFIG?.trim();
    const hostConfigPath = process.env.CLAUDE_CODE_SETTINGS_PATH?.trim();
    const hostAuxConfigPath = process.env.CLAUDE_CODE_MCP_CONFIG_PATH?.trim();
    return tokenPilotConfigPath || hostConfigPath || hostAuxConfigPath
      ? { tokenPilotConfigPath, hostConfigPath, hostAuxConfigPath }
      : undefined;
  }
  if (host === "pi") {
    const tokenPilotConfigPath = process.env.TOKENPILOT_PI_CONFIG?.trim();
    return tokenPilotConfigPath ? { tokenPilotConfigPath } : undefined;
  }
  if (host === "opencode") {
    const tokenPilotConfigPath = process.env.TOKENPILOT_OPENCODE_CONFIG?.trim();
    const configDir = process.env.TOKENPILOT_OPENCODE_CONFIG_DIR?.trim();
    const hostConfigPath = configDir ? `${configDir.replace(/[\\/]+$/, "")}/opencode.json` : undefined;
    return tokenPilotConfigPath || hostConfigPath ? { tokenPilotConfigPath, hostConfigPath } : undefined;
  }
  return undefined;
}

function parseBooleanContextCommand(args: string[]): boolean {
  return args.length === 1 && args[0] === "context";
}

async function resolvePathOverrides(host: CliHostId): Promise<CliHostPathOverrides | undefined> {
  return currentEnvPathOverrides(host) ?? (await readCliContextState()).configPathsByHost?.[host];
}

async function resolveDefaultTarget(): Promise<HostTarget | undefined> {
  const state = await readCliContextState();
  const host = state.lastActiveHost;
  if (!host) return undefined;
  const sessionId = state.lastSessionByHost?.[host];
  const pathOverrides = state.configPathsByHost?.[host];
  return { host, sessionId, pathOverrides };
}

async function resolveTarget(argv: string[]): Promise<{
  target?: HostTarget;
  commandArgs: string[];
  handledText?: string;
  /** True only when this invocation's argv named the session, not stored context. */
  sessionFromArgv?: boolean;
}> {
  if (parseBooleanContextCommand(argv)) {
    const state = await readCliContextState();
    const lines = [
      "LightRSI CLI context:",
      `- lastActiveHost: ${state.lastActiveHost ?? "(unset)"}`,
      ...CLI_HOSTS.map((host) => `- ${host.hostId} session: ${state.lastSessionByHost?.[host.hostId] ?? "(unset)"}`),
      ...CLI_HOSTS.map((host) => {
        const overrides = state.configPathsByHost?.[host.hostId];
        const summary = [
          overrides?.tokenPilotConfigPath,
          overrides?.hostConfigPath,
          overrides?.hostAuxConfigPath,
        ].filter(Boolean);
        return `- ${host.hostId} config target: ${summary.length > 0 ? summary.join(" | ") : "(unset)"}`;
      }),
      `- lastUpdatedAt: ${state.lastUpdatedAt ?? "(unset)"}`,
    ];
    return { commandArgs: [], handledText: lines.join("\n") };
  }

  if (argv[0] === "use") {
    const host = parseCliHostId(argv[1]);
    if (!host) {
      return { commandArgs: [], handledText: `Unknown host.\n\n${formatCliUsage()}` };
    }
    if (argv[2] === "session") {
      let sessionId = String(argv[3] ?? "").trim();
      if (!sessionId) {
        return { commandArgs: [], handledText: "Missing session id." };
      }
      const runtime = createCliHostRuntime({
        host,
        sessionId,
        pathOverrides: await resolvePathOverrides(host),
      });
      sessionId = (await runtime.resolveSessionId(sessionId)) ?? sessionId;
      await updateCliContextState({ host, sessionId, pathOverrides: await resolvePathOverrides(host) });
      return { commandArgs: [], handledText: `Default context = ${host} / ${sessionId}` };
    }
    await updateCliContextState({ host, pathOverrides: await resolvePathOverrides(host) });
    return { commandArgs: [], handledText: `Default host = ${host}` };
  }

  const explicitHost = parseCliHostId(argv[0]);
  if (explicitHost) {
    if (argv[1] === "session") {
      const sessionId = String(argv[2] ?? "").trim();
      const commandArgs = argv.slice(3);
      return {
        target: {
          host: explicitHost,
          sessionId: sessionId || undefined,
          pathOverrides: await resolvePathOverrides(explicitHost),
        },
        commandArgs,
        sessionFromArgv: Boolean(sessionId),
      };
    }
    return {
      target: { host: explicitHost, pathOverrides: await resolvePathOverrides(explicitHost) },
      commandArgs: argv.slice(1),
    };
  }

  const defaultTarget = await resolveDefaultTarget();
  return {
    target: defaultTarget,
    commandArgs: argv,
  };
}

export async function dispatchCli(argv: string[]): Promise<ProductCommandResult> {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    return { text: formatCliUsage() };
  }

  const resolved = await resolveTarget(argv);
  if (resolved.handledText) {
    return { text: resolved.handledText };
  }

  const { target, commandArgs, sessionFromArgv } = resolved;
  if (commandArgs.length === 1 && commandArgs[0] === "visual") {
    return handleStandaloneVisualCommandWithSelection({
      host: target?.host,
      sessionId: target?.sessionId,
    });
  }
  if (!target) {
    return {
      text: `No default host is selected.\n\n${formatCliUsage()}`,
    };
  }
  if (commandArgs.length === 0) {
    return {
      text: formatCliUsage(),
    };
  }

  let effectiveTarget = target;
  let latestReportNotice: string | undefined;
  if (
    argv.length > 0
    && commandArgs.length === 1
    && commandArgs[0] === "report"
    && !parseCliHostId(argv[0])
  ) {
    const latestHost = await resolveLatestCliReportHost();
    if (latestHost) {
      effectiveTarget = {
        host: latestHost.hostId,
        sessionId: latestHost.hostId === target.host ? target.sessionId : undefined,
        pathOverrides: await resolvePathOverrides(latestHost.hostId),
      };
      latestReportNotice = `Showing latest TokenPilot report from ${latestHost.displayName} (${latestHost.latestAt}).`;
    }
  }

  const runtime = createCliHostRuntime({
    host: effectiveTarget.host,
    sessionId: effectiveTarget.sessionId,
    pathOverrides: await resolvePathOverrides(effectiveTarget.host) ?? effectiveTarget.pathOverrides,
  });
  if (commandArgs[0] === "clean") {
    if (commandArgs.slice(1).some((argument) => argument === "--help" || argument === "-h")) {
      return { text: formatCleanUsage() };
    }
    // RY-03: the Cleaner entry point binds to the session named in this
    // invocation, or to one the Host can vouch for. Stored context can carry a
    // session an earlier latest-session guess wrote, so it is not an explicit
    // choice here, and analyzing the wrong conversation is not recoverable.
    const boundSessionId = cleanSessionIdFromArgs(commandArgs.slice(1))
      ?? (sessionFromArgv ? effectiveTarget.sessionId : undefined)
      ?? await runtime.resolveCurrentSessionId?.();
    if (!boundSessionId && cleanCommandRequiresSessionId(commandArgs.slice(1))) {
      return {
        text: formatCleanSessionRequired({
          hostId: effectiveTarget.host,
          recentSessionId: await runtime.maybeResolveLatestSessionId(),
        }),
      };
    }
    const resolvedSessionId = boundSessionId
      ? await runtime.resolveSessionId(boundSessionId)
      : undefined;
    const cleanPathOverrides = await resolvePathOverrides(effectiveTarget.host)
      ?? effectiveTarget.pathOverrides;
    const backend = await resolveCleanCommandBackend({
      hostId: effectiveTarget.host,
      sessionId: resolvedSessionId,
      pathOverrides: cleanPathOverrides,
    });
    if (!backend) {
      return {
        text: `Context Cleaner is not registered for ${effectiveTarget.host} yet.`,
      };
    }
    const result = await handleCleanCommand({
      args: commandArgs.slice(1),
      sessionId: resolvedSessionId,
      backend,
    });
    await updateCliContextState({
      host: effectiveTarget.host,
      sessionId: resolvedSessionId,
      pathOverrides: cleanPathOverrides,
    });
    return result;
  }
  const result = await runtime.handleCommand({
    args: commandArgs.join(" "),
    sessionId: effectiveTarget.sessionId,
  });

  const resolvedSessionId = effectiveTarget.sessionId
    ? await runtime.resolveSessionId(effectiveTarget.sessionId)
    : await runtime.maybeResolveLatestSessionId();
  await updateCliContextState({
    host: effectiveTarget.host,
    sessionId: resolvedSessionId,
    pathOverrides: await resolvePathOverrides(effectiveTarget.host) ?? effectiveTarget.pathOverrides,
  });
  if (latestReportNotice && result.text.startsWith("TokenPilot report:")) {
    return { text: `${latestReportNotice}\n${result.text}` };
  }
  return result;
}
