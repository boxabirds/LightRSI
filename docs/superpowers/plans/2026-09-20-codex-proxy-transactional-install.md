# Codex Proxy Transactional Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a successful TokenPilot Codex installation leave a healthy local proxy running before Codex is routed to it, and preserve a direct upstream route if proxy startup fails.

**Architecture:** Treat installation as a prepare/start/commit transaction. Prepare TokenPilot state, hooks, MCP, and CLI assets first; start the daemon and wait for its existing `/health` gate; atomically commit the Codex routing change only after health succeeds. If startup or the final commit fails, stop the partial daemon and write a direct-provider fallback derived from the already-captured upstream configuration.

**Tech Stack:** TypeScript, Node.js 22, `node:test`, filesystem atomic rename, existing `startDaemon`/`stopDaemon` lifecycle.

**Spec:** `docs/superpowers/plans/2026-09-20-codex-proxy-transactional-install.md` — the Design Baseline section below is the approved bounded design.

## Design Baseline

- Installation success means the configured proxy port is listening and `/health` has passed before `config.toml` points Codex at loopback.
- A failed install must not leave Codex routed to an unavailable loopback endpoint.
- Reinstalling an already-intercepted provider must use `tokenPilotConfig.upstream` as the direct fallback, not restore a dead loopback URL.
- `SessionStart` remains an idempotent recovery path, but it is no longer the first mechanism that starts the proxy after installation.
- This change does not add an OS service or infinite restart loop. If the proxy later exits, lifecycle evidence should be collected before designing supervision.

## Global Constraints

- Preserve existing custom-provider, built-in OpenAI, legacy-provider migration, port-shift, MCP, hook, and CLI behavior.
- Do not log or persist Authorization headers, API keys, request bodies, or raw prompts.
- Use the existing five-second health wait in `startDaemon`; do not add a second independent polling implementation.
- All filesystem commits that can change Codex routing must use write-temp-then-rename semantics.
- Windows and POSIX launch paths must both resolve the bundled `dist/cli.js` explicitly.
- Do not change Responses API forwarding or stream retry behavior in this plan.

## Review Focus

- Fresh install from a remote provider: daemon becomes healthy before the loopback route is visible; covered in Task 2.
- Reinstall while the current config already points to loopback: a failed restart restores the persisted real upstream; covered in Task 1 and Task 2.
- Preferred proxy port occupied: the selected replacement port is the one started and committed; covered in Task 2.
- Daemon child exits before health: install fails, removes the PID, and leaves direct routing; covered in Task 2.
- Final atomic config commit fails: the newly started daemon is stopped and the original/direct config remains usable; covered in Task 2.

---

### Task 1: Extract atomic routing commit and direct-fallback construction

**Files:**
- Modify: `components/adapters/codex/src/install.ts:36-180`
- Test: `components/adapters/codex/tests/install.test.ts`

**Interfaces:**
- Consumes: `CodexProviderConfig`, existing `replaceOrInsertRootAssignment`, `rewriteProviderSectionForProxy`, `removeProviderSectionFamily`.
- Produces: `writeTextFileAtomic(path: string, text: string): Promise<void>`, `ensureTrailingNewline(text: string): string`, `buildProxiedCodexConfig(params): string`, and `buildDirectCodexProviderConfig(params): string` for Task 2.

- [ ] **Step 1: Write failing tests for direct fallback generation**

Add exported-for-test coverage through the installation behavior rather than testing private string helpers directly. Reuse the existing per-test temporary-directory setup and add this dependency helper before the tests:

```ts
function failingDaemonDependencies(): Partial<CodexInstallDependencies> {
  return {
    startDaemon: async () => {
      throw new Error("fixture_daemon_start_failed");
    },
  };
}

async function createInstallFixture(params: {
  provider: "openai" | "OPENAI";
}): Promise<{
  root: string;
  codexConfigPath: string;
  tokenPilotConfigPath: string;
  hooksConfigPath: string;
  params: CodexInstallParams;
}> {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-codex-transaction-"));
  const codexConfigPath = join(root, "config.toml");
  const tokenPilotConfigPath = join(root, "tokenpilot.json");
  const hooksConfigPath = join(root, "hooks.json");
  const providerSection = params.provider === "OPENAI"
    ? [
        "",
        "[model_providers.OPENAI]",
        'name = "OpenAI"',
        'base_url = "https://api.openai.com/v1"',
        'wire_api = "responses"',
        "requires_openai_auth = true",
      ]
    : [];
  await writeFile(codexConfigPath, [
    `model_provider = ${JSON.stringify(params.provider)}`,
    ...providerSection,
    "",
  ].join("\n"), "utf8");
  await writeTokenPilotCodexConfig(normalizeTokenPilotCodexConfig({
    enabled: false,
    stateDir: join(root, "state"),
    proxyPort: await reserveUnusedPort(),
  }), tokenPilotConfigPath);
  return {
    root,
    codexConfigPath,
    tokenPilotConfigPath,
    hooksConfigPath,
    params: {
      codexConfigPath,
      tokenPilotConfigPath,
      hooksConfigPath,
      cliBinDir: join(root, "bin"),
      cliContextPath: join(root, ".lightrsi", "state", "cli-context.json"),
      probeMcp: false,
    },
  };
}

async function createAlreadyInterceptedFixture(params: {
  proxyBaseUrl: string;
  upstreamBaseUrl: string;
}) {
  const fixture = await createInstallFixture({ provider: "OPENAI" });
  const proxyPort = Number(new URL(params.proxyBaseUrl).port);
  await writeFile(fixture.codexConfigPath, [
    'model_provider = "OPENAI"',
    "",
    "[model_providers.OPENAI]",
    'name = "OpenAI"',
    `base_url = ${JSON.stringify(params.proxyBaseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "",
  ].join("\n"), "utf8");
  await writeTokenPilotCodexConfig(normalizeTokenPilotCodexConfig({
    enabled: true,
    stateDir: join(fixture.root, "state"),
    proxyPort,
    providerName: "OPENAI",
    upstreamProvider: "OPENAI",
    upstream: {
      name: "OpenAI",
      baseUrl: params.upstreamBaseUrl,
      wireApi: "responses",
      requiresOpenAIAuth: true,
    },
  }), fixture.tokenPilotConfigPath);
  return fixture;
}
```

Add two tests to `install.test.ts` using the same explicit `codexConfigPath`, `hooksConfigPath`, and `tokenPilotConfigPath` construction already used by the surrounding tests:

```ts
test("failed built-in OpenAI proxy start preserves a direct OpenAI route", async () => {
  const fixture = await createInstallFixture({ provider: "openai" });
  await assert.rejects(
    installCodexTokenPilot(fixture.params, {
      startDaemon: async () => { throw new Error("fixture_daemon_start_failed"); },
      stopDaemon: async (config) => ({
        ...(await readDaemonStatus(config)),
        stopped: false,
      }),
    }),
    /fixture_daemon_start_failed/,
  );
  const text = await readFile(fixture.codexConfigPath, "utf8");
  assert.match(text, /model_provider = "openai"/);
  assert.match(text, /openai_base_url = "https:\/\/api\.openai\.com\/v1"/);
  assert.doesNotMatch(text, /127\.0\.0\.1/);
});

test("failed reinstall replaces an old loopback route with the persisted upstream", async () => {
  const fixture = await createAlreadyInterceptedFixture({
    proxyBaseUrl: "http://127.0.0.1:17667/v1",
    upstreamBaseUrl: "https://provider.example/v1",
  });
  await assert.rejects(
    installCodexTokenPilot(fixture.params, failingDaemonDependencies()),
    /fixture_daemon_start_failed/,
  );
  const text = await readFile(fixture.codexConfigPath, "utf8");
  assert.match(text, /base_url = "https:\/\/provider\.example\/v1"/);
  assert.doesNotMatch(text, /127\.0\.0\.1/);
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```powershell
npm --prefix components/adapters/codex test -- --test-name-pattern="failed built-in OpenAI|failed reinstall"
```

Expected: FAIL because `installCodexTokenPilot` does not accept lifecycle dependencies and writes loopback before daemon startup.

- [ ] **Step 3: Add lifecycle dependency and atomic-write types**

In `install.ts`, import `rename` and `startDaemon`, then define:

```ts
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import {
  startDaemon,
  stopDaemon,
  type DaemonStatus,
} from "./daemon.js";

export type CodexInstallDependencies = {
  startDaemon: typeof startDaemon;
  stopDaemon: typeof stopDaemon;
  writeCodexConfig: typeof writeTextFileAtomic;
};

const DEFAULT_CODEX_INSTALL_DEPENDENCIES: CodexInstallDependencies = {
  startDaemon,
  stopDaemon,
  writeCodexConfig: writeTextFileAtomic,
};

async function writeTextFileAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, text, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
```

Change the public function signature without changing existing callers:

```ts
export async function installCodexTokenPilot(
  params?: CodexInstallParams,
  dependencyOverrides: Partial<CodexInstallDependencies> = {},
): Promise<CodexInstallResult> {
  const dependencies = {
    ...DEFAULT_CODEX_INSTALL_DEPENDENCIES,
    ...dependencyOverrides,
  };
```

Extract the current inline parameter and result object types as exported `CodexInstallParams` and `CodexInstallResult`. Add this field to the result:

```ts
daemon: DaemonStatus & { started: boolean };
```

- [ ] **Step 4: Implement proxied and direct-provider config construction**

Extract the existing inline loopback-routing code into this private helper:

```ts
function buildProxiedCodexConfig(params: {
  existing: string;
  providerName: string;
  builtInOpenAI: boolean;
  baseUrl: string;
  interceptedProvider?: CodexProviderConfig;
  mcpServer: TokenPilotMcpServerSpec;
}): string {
  let next = replaceOrInsertRootAssignment(
    params.existing,
    "model_provider",
    quoteToml(params.providerName),
  );
  next = params.builtInOpenAI
    ? replaceOrInsertRootAssignment(
        removeProviderSectionFamily(
          removeProviderSectionFamily(next, "openai"),
          LEGACY_OPENAI_PROXY_PROVIDER,
        ),
        "openai_base_url",
        quoteToml(params.baseUrl),
      )
    : rewriteProviderSectionForProxy(next, {
        providerName: params.providerName,
        baseUrl: params.baseUrl,
        displayName: params.interceptedProvider?.name ?? params.providerName,
        wireApi: params.interceptedProvider?.wireApi ?? "responses",
        requiresOpenAIAuth: params.interceptedProvider?.requiresOpenAIAuth ?? true,
      });
  return upsertMcpServerSection(next, {
    serverName: params.mcpServer.serverName,
    command: params.mcpServer.command,
    args: params.mcpServer.args,
    env: params.mcpServer.env,
    startupTimeoutSec: DEFAULT_TOKENPILOT_MCP_STARTUP_TIMEOUT_SEC,
  });
}
```

Add a private helper that restores the selected provider from the captured real upstream:

```ts
function buildDirectCodexProviderConfig(params: {
  existing: string;
  providerName: string;
  builtInOpenAI: boolean;
  upstream: CodexProviderConfig;
}): string {
  let next = replaceOrInsertRootAssignment(
    params.existing,
    "model_provider",
    quoteToml(params.providerName),
  );
  if (params.builtInOpenAI) {
    next = removeProviderSectionFamily(next, "openai");
    next = removeProviderSectionFamily(next, LEGACY_OPENAI_PROXY_PROVIDER);
    return replaceOrInsertRootAssignment(
      next,
      "openai_base_url",
      quoteToml(params.upstream.baseUrl),
    );
  }
  return rewriteProviderSectionForProxy(next, {
    providerName: params.providerName,
    baseUrl: params.upstream.baseUrl,
    displayName: params.upstream.name ?? params.providerName,
    wireApi: params.upstream.wireApi,
    requiresOpenAIAuth: params.upstream.requiresOpenAIAuth,
  });
}
```

Before any daemon stop, assert that `upstreamProvider?.baseUrl` exists and is not loopback. Use the resulting direct config as the failure-safe routing value.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npm --prefix components/adapters/codex test -- --test-name-pattern="failed built-in OpenAI|failed reinstall"
```

Expected: tests still FAIL until Task 2 connects startup failure to the fallback commit; TypeScript compiles with the new interfaces.

- [ ] **Step 6: Commit the isolated primitives**

```powershell
git add components/adapters/codex/src/install.ts components/adapters/codex/tests/install.test.ts
git commit -m "refactor(codex): prepare transactional proxy installation"
```

### Task 2: Start and health-gate the daemon before committing loopback routing

**Files:**
- Modify: `components/adapters/codex/src/install.ts:440-604`
- Modify: `components/adapters/codex/tests/install.test.ts:107-808`

**Interfaces:**
- Consumes: `CodexInstallDependencies`, `writeTextFileAtomic`, `buildDirectCodexProviderConfig`, `startDaemon(config, options)`.
- Produces: installation invariant `result.daemon.running === true` before loopback routing is committed.

- [ ] **Step 1: Add a successful installation ordering test**

Add a fake `startDaemon` that reads `config.toml` during startup and proves it still contains the remote endpoint:

```ts
test("install starts a healthy daemon before committing loopback routing", async () => {
  const fixture = await createInstallFixture({ provider: "OPENAI" });
  let configObservedDuringStart = "";
  const result = await installCodexTokenPilot(fixture.params, {
    startDaemon: async (config) => {
      configObservedDuringStart = await readFile(fixture.codexConfigPath, "utf8");
      return {
        running: true,
        started: true,
        pid: 4242,
        ...daemonPaths(config),
      };
    },
    stopDaemon: async (config) => ({
      running: false,
      stopped: false,
      ...daemonPaths(config),
    }),
  });
  assert.match(configObservedDuringStart, /https:\/\/api\.openai\.com\/v1/);
  assert.doesNotMatch(configObservedDuringStart, /127\.0\.0\.1/);
  assert.equal(result.daemon.running, true);
  assert.match(await readFile(fixture.codexConfigPath, "utf8"), /127\.0\.0\.1/);
});
```

- [ ] **Step 2: Change the existing daemon-stop contract test**

Rename:

```ts
"installCodexTokenPilot stops an existing daemon before resolving the proxy port"
```

to:

```ts
"installCodexTokenPilot replaces an existing daemon and leaves the proxy healthy"
```

Replace the final assertion:

```ts
assert.equal((await readDaemonStatus(persisted)).running, false);
```

with:

```ts
const daemon = await readDaemonStatus(persisted);
assert.equal(daemon.running, true);
assert.equal(result.daemon.running, true);
await stopDaemon(persisted);
```

- [ ] **Step 3: Add startup and final-commit failure tests**

Add tests that assert:

```ts
assert.doesNotMatch(await readFile(codexConfigPath, "utf8"), /127\.0\.0\.1/);
assert.equal(stopCalls, 1);
await assert.rejects(readFile(daemonPaths(config).pidPath, "utf8"), { code: "ENOENT" });
```

For final-commit failure, inject this deterministic writer instead of relying on platform-specific file permissions:

```ts
writeCodexConfig: async () => {
  throw new Error("fixture_codex_config_commit_failed");
},
```

Assert the install rejects with `fixture_codex_config_commit_failed`, the fake stop dependency is called once, and the final file contains the direct upstream rather than loopback.

- [ ] **Step 4: Reorder the installation transaction**

Restructure `installCodexTokenPilot` into this exact order:

```ts
const existing = existsSync(codexConfigPath)
  ? await readFile(codexConfigPath, "utf8")
  : "";
const directConfig = buildDirectCodexProviderConfig({
  existing,
  providerName,
  builtInOpenAI,
  upstream: upstreamProvider,
});

// Prepare assets without changing Codex routing. Move the existing,
// argument-complete hook, skill, CLI, host CLI, and context calls here.
await writeTokenPilotCodexConfig(tokenPilotConfig, tokenPilotConfigPath);

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
try {
  await dependencies.stopDaemon(tokenPilotConfig).catch(() => undefined);
  tokenPilotConfig.proxyPort = await resolveAvailableCodexProxyPort(
    tokenPilotConfig.proxyPort,
    { waitForPreferredMs: 1_000 },
  );
  await writeTokenPilotCodexConfig(tokenPilotConfig, tokenPilotConfigPath);

  daemon = await dependencies.startDaemon(tokenPilotConfig, {
    configPath: tokenPilotConfigPath,
    codexConfigPath,
    cliPath: join(adapterRootFromHere(), "dist", "cli.js"),
  });
  if (!daemon.running) throw new Error("tokenpilot_codex_daemon_unhealthy_after_start");

  const baseUrl = `http://127.0.0.1:${tokenPilotConfig.proxyPort}/v1`;
  const proxiedConfig = buildProxiedCodexConfig({
    existing,
    providerName,
    builtInOpenAI,
    baseUrl,
    interceptedProvider,
    mcpServer,
  });
  await copyFile(codexConfigPath, `${codexConfigPath}.tokenpilot.bak`).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  await dependencies.writeCodexConfig(codexConfigPath, ensureTrailingNewline(proxiedConfig));
} catch (error) {
  await dependencies.stopDaemon(tokenPilotConfig).catch(() => undefined);
  await writeTextFileAtomic(codexConfigPath, ensureTrailingNewline(directConfig));
  throw error;
}
```

Compute `proxiedConfig` only after the final port is selected so its loopback URL matches the daemon that actually started. Keep MCP probe degradation non-fatal and run it after routing commit.

- [ ] **Step 5: Verify all install tests**

Run:

```powershell
node --import tsx --test components/adapters/codex/tests/install.test.ts components/adapters/codex/tests/daemon.test.ts
```

Expected: PASS, including existing custom-provider, built-in OpenAI, occupied-port, monotonic-clock, hook, MCP, and CLI tests.

- [ ] **Step 6: Commit the transactional install behavior**

```powershell
git add components/adapters/codex/src/install.ts components/adapters/codex/tests/install.test.ts
git commit -m "fix(codex): health-gate proxy routing during install"
```

### Task 3: Make the release installer and E2E enforce the new invariant

**Files:**
- Modify: `components/adapters/codex/scripts/install-codex.ts:8-33`
- Create: `components/adapters/codex/tests/install-script.test.ts`
- Modify: `components/adapters/codex/tests/e2e.test.ts:34-260`
- Modify: `components/adapters/codex/README.md` under Install, Verify, and Debugging

**Interfaces:**
- Consumes: `CodexInstallResult.daemon` from Task 2.
- Produces: user-visible proof that installation returned with a running proxy and an E2E test that no longer starts the proxy manually.

- [ ] **Step 1: Add a failing unit test for installer status output**

Create `tests/install-script.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { formatProxyInstallStatus } from "../scripts/install-codex.js";

test("installer reports a healthy proxy without deferred-start instructions", () => {
  const lines = formatProxyInstallStatus({
    running: true,
    started: true,
    pid: 4242,
    pidPath: "C:/fixture/tokenpilot-codex.pid",
    logPath: "C:/fixture/tokenpilot-codex.log",
  });
  assert.deepEqual(lines, [
    "Proxy daemon: running",
    "Proxy health: ok",
    "Proxy log: C:/fixture/tokenpilot-codex.log",
    "SessionStart hooks remain installed as an idempotent recovery path.",
  ]);
  assert.equal(lines.some((line) => line.includes("start a new Codex session")), false);
});
```

Run:

```powershell
node --import tsx --test components/adapters/codex/tests/install-script.test.ts
```

Expected: FAIL because `formatProxyInstallStatus` is not exported.

- [ ] **Step 2: Update release-installer output**

Import `type CodexInstallResult` alongside `installCodexTokenPilot`, export a narrow formatter, call it from `main`, and guard direct execution so the test can import the module:

```ts
export function formatProxyInstallStatus(
  daemon: CodexInstallResult["daemon"],
): string[] {
  return [
    `Proxy daemon: ${daemon.running ? "running" : "not running"}`,
    `Proxy health: ${daemon.running ? "ok" : "failed"}`,
    `Proxy log: ${daemon.logPath}`,
    "SessionStart hooks remain installed as an idempotent recovery path.",
  ];
}

async function main(): Promise<void> {
  const result = await installCodexTokenPilot({
    codexConfigPath: process.env.CODEX_CONFIG_PATH,
    tokenPilotConfigPath: process.env.TOKENPILOT_CODEX_CONFIG,
    hooksConfigPath: process.env.CODEX_HOOKS_CONFIG_PATH,
  });
  // Keep the existing summary lines, then:
  for (const line of formatProxyInstallStatus(result.daemon)) console.log(line);
}

if (/install-codex\.(?:js|ts)$/u.test(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
```

Do not print configuration contents or credentials.

- [ ] **Step 3: Remove manual proxy startup from the primary E2E test**

In the first E2E test, capture the result of `installCodexTokenPilot`, delete the manual `codexToml` rewrite at lines 103-127, and delete the explicit `startCodexResponsesProxy` call at lines 129-134. Keep the existing request method, headers, and body at lines 136-167 unchanged except for using `result.baseUrl`; import `stopDaemon` and clean up the installed daemon in `finally`:

```ts
const result = await installCodexTokenPilot({
  codexConfigPath,
  hooksConfigPath,
  tokenPilotConfigPath,
});
assert.equal(result.daemon.running, true);
const response = await fetch(`${result.baseUrl}/responses`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(requestPayload),
});
assert.equal(response.status, 200);

const installedConfig = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
await stopDaemon(installedConfig);
```

Define `requestPayload` immediately before the fetch by moving the existing object currently passed to `JSON.stringify` at lines 141-165 without changing its fields. Retain all existing response, reduction, report, and visual assertions.

- [ ] **Step 4: Update README operational contract**

Document these exact expectations:

- successful install returns only after `/health` passes;
- Codex routing remains direct if daemon startup fails;
- `SessionStart` checks/restarts the daemon but is no longer required for initial startup;
- `tokenpilot-codex.log` is the first file to inspect if a later session loses the proxy.

- [ ] **Step 5: Run adapter verification**

Run:

```powershell
npm --prefix components/adapters/codex run typecheck
npm --prefix components/adapters/codex test
npm --prefix components/adapters/codex run build
```

Expected: all commands exit 0.

- [ ] **Step 6: Run repository-level installer tests**

Run:

```powershell
node --test scripts/tests/install-cleaner.test.mjs
```

Expected: all installer planning and stale-artifact checks pass.

- [ ] **Step 7: Commit release behavior and documentation**

```powershell
git add components/adapters/codex/scripts/install-codex.ts components/adapters/codex/tests/install-script.test.ts components/adapters/codex/tests/e2e.test.ts components/adapters/codex/README.md
git commit -m "test(codex): enforce healthy proxy after installation"
```

### Task 4: Final regression and sanitized smoke evidence

**Files:**
- No production files expected.
- Evidence remains terminal output; do not add generated logs to Git.

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: verified release behavior on the current Windows host.

- [ ] **Step 1: Build the release artifacts used by daemon startup**

Run:

```powershell
npm --prefix components/adapters/codex run build
```

Expected: `components/adapters/codex/dist/cli.js` exists and the command exits 0.

- [ ] **Step 2: Run the complete adapter suite**

Run:

```powershell
npm --prefix components/adapters/codex run typecheck
npm --prefix components/adapters/codex test
```

Expected: both commands exit 0 with no failed tests.

- [ ] **Step 3: Run an isolated install smoke test**

Use a temporary HOME/USERPROFILE and an unused loopback port. Verify in order:

```text
installer exits 0
tokenpilot.json contains the selected port and real upstream
GET /health returns 200 and adapter=tokenpilot-codex
config.toml points to exactly that selected port
tokenpilot-codex.pid names a live process
stopDaemon removes the process and PID file
```

The smoke must use a loopback mock upstream and must not read the developer's real API key or real Codex configuration.

- [ ] **Step 4: Inspect the final diff**

Run:

```powershell
git diff --check
git diff --stat HEAD~3..HEAD
git status --short
```

Expected: no whitespace errors; only the files named in this plan plus the plan itself are changed.
