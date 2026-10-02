/**
 * Fail-open guard and file logger for in-process adapters.
 *
 * In-process hosts own the terminal (for example OpenCode's TUI), so adapter
 * diagnostics go to `<stateDir>/tokenpilot/adapter.log`, never stdout/stderr.
 * `failOpen` runs a hook body and, on any error, logs it and returns the
 * host-neutral fallback (leave the request unmodified).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type AdapterLogger = {
  info(message: string, detail?: unknown): void;
  debug(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
};

export function adapterLogPath(stateDir: string): string {
  return join(stateDir, "tokenpilot", "adapter.log");
}

function formatDetail(detail: unknown): string {
  if (detail === undefined) return "";
  if (detail instanceof Error) return ` ${detail.name}: ${detail.message}`;
  try {
    return ` ${JSON.stringify(detail)}`;
  } catch {
    return ` ${String(detail)}`;
  }
}

export function createFileLogger(params: {
  hostId: string;
  stateDir: () => string | undefined;
  debug: () => boolean;
}): AdapterLogger {
  const write = (level: string, message: string, detail?: unknown) => {
    const stateDir = params.stateDir();
    if (!stateDir) return;
    try {
      const path = adapterLogPath(stateDir);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${new Date().toISOString()} ${level} [${params.hostId}] ${message}${formatDetail(detail)}\n`, "utf8");
    } catch {
      // Logging is best-effort; never let it affect the host.
    }
  };
  return {
    info: (message, detail) => write("info", message, detail),
    warn: (message, detail) => write("warn", message, detail),
    debug: (message, detail) => {
      if (params.debug()) write("debug", message, detail);
    },
  };
}

export async function failOpen<T>(
  logger: AdapterLogger,
  hook: string,
  body: () => Promise<T> | T,
  fallback: T,
): Promise<T> {
  try {
    return await body();
  } catch (error) {
    logger.warn(`${hook} failed open`, error);
    return fallback;
  }
}
