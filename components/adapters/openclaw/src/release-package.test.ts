import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageDir = resolve(__dirname, "..");
const tarCommand = process.platform === "win32"
  ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
  : "tar";

function resolveBashCommand(): string {
  const configured = process.env.LIGHTRSI_TEST_BASH?.trim();
  if (configured) return configured;
  if (process.platform !== "win32") return "bash";
  try {
    const gitPath = execFileSync("where.exe", ["git"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((candidate) => candidate.trim())
      .find(Boolean);
    if (gitPath) {
      const gitBash = join(dirname(dirname(gitPath)), "bin", "bash.exe");
      if (existsSync(gitBash)) return gitBash;
    }
  } catch {
    // The fallback below preserves the existing behavior on systems without Git Bash.
  }
  return "bash";
}

function bashPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (process.platform !== "win32") return normalized;
  return normalized.replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`);
}

function shellPath(value: string): string {
  return `'${bashPath(value).replaceAll("'", `'\"'\"'`)}'`;
}

async function withTempDir(prefix: string, run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runReleaseScript(root: string, commands: string[]) {
  return execFileAsync(resolveBashCommand(), ["-c", [
    `source ${shellPath(join(packageDir, "scripts", "install_release.sh"))}`,
    ...commands,
  ].join("\n")], { env: { ...process.env, HOME: join(root, "home") } });
}

function execWithInput(command: string, args: string[], input: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`command_failed:${code}:${stderr}`));
    });
    child.stdin.end(input);
  });
}

test("release installer uses OpenClaw managed installation for capability consent", async () => {
  const script = await readFile(join(packageDir, "scripts", "install_release.sh"), "utf8");
  assert.match(
    script,
    /openclaw_cmd plugins install "\$\{archive_path\}" --force --accept-capabilities/,
  );
  assert.doesNotMatch(script, /tar -xzf "\$\{archive_path\}"/);
  assert.match(script, /configure-release\.cjs/);
  assert.doesNotMatch(script, /python3/);
  const configHelper = await readFile(join(packageDir, "scripts", "configure-release.cjs"), "utf8");
  assert.match(configHelper, /pluginConfig\.proxyAutostart = false/);
  assert.match(configHelper, /slots\.contextEngine = "tokenpilot"/);
  assert.match(script, /install_bundled_cli/);
  assert.match(script, /INSTALLED_PLUGIN_PATH\}\/dist\/install-cli\.js/);
});

test("release package loads without monorepo workspace dependencies", async () => {
  const extractDir = await mkdtemp(join(tmpdir(), "tokenpilot-release-smoke-"));
  const staleDistPath = join(packageDir, "dist", "stale-release-sentinel.txt");
  let archivePath = "";

  try {
    await writeFile(staleDistPath, "must not ship\n", "utf8");
    const fakeNodeDir = join(extractDir, "fake-node");
    const packPath = process.platform === "win32"
      ? `${fakeNodeDir};${process.env.PATH ?? ""}`
      : process.env.PATH;
    if (process.platform === "win32") {
      await mkdir(fakeNodeDir, { recursive: true });
      const fakeNode = join(fakeNodeDir, "node");
      await writeFile(fakeNode, "#!/usr/bin/env bash\nexit 97\n", "utf8");
      await chmod(fakeNode, 0o755);
    }
    const result = await execFileAsync(resolveBashCommand(), ["scripts/pack_release.sh"], {
      cwd: packageDir,
      env: {
        ...process.env,
        PATH: packPath,
        NPM_CACHE_DIR: join(extractDir, "npm-cache"),
      },
    });
    archivePath = result.stdout.trim().split("\n").at(-1) ?? "";
    assert.match(archivePath, /lightrsi-openclaw-adapter-.*\.tgz$/);

    await execFileAsync(tarCommand, ["-xzf", archivePath, "-C", extractDir]);
    const installedDir = join(extractDir, "package");
    const manifest = JSON.parse(await readFile(join(installedDir, "package.json"), "utf8"));
    assert.equal(manifest.name, "@lightrsi/openclaw-adapter");
    assert.equal(manifest.dependencies, undefined);
    assert.equal(manifest.devDependencies, undefined);
    assert.deepEqual(manifest.files, [
      "dist/index.js",
      "dist/index.js.map",
      "openclaw.plugin.json",
      "README.md",
      "dist/install-cli.js",
      "dist/install-cli.js.map",
      "dist/lightrsi.js",
      "dist/cli.js.map",
    ]);
    assert.deepEqual(manifest.bin, {
      lightrsi: "dist/lightrsi.js",
      lightmem2: "dist/lightrsi.js",
    });
    const pluginManifest = JSON.parse(
      await readFile(join(installedDir, "openclaw.plugin.json"), "utf8"),
    );
    assert.equal(pluginManifest.kind, "context-engine");

    const require = createRequire(__filename);
    const plugin = require(join(installedDir, "dist", "index.js"));
    assert.equal(plugin.id, "tokenpilot");
    assert.equal(plugin.kind, "context-engine");
    assert.equal(typeof plugin.register, "function");

    const cliPath = join(installedDir, "dist", "lightrsi.js");
    const cliSource = await readFile(cliPath, "utf8");
    assert.match(cliSource, /^#!\/usr\/bin\/env node/);
    assert.match(cliSource, /\/\/# sourceMappingURL=cli\.js\.map\s*$/);
    assert.equal(existsSync(join(installedDir, "dist", "cli.js.map")), true);
    assert.equal(existsSync(join(installedDir, "dist", "stale-release-sentinel.txt")), false);
    const cliHelp = await execFileAsync(process.execPath, [cliPath, "--help"]);
    assert.match(cliHelp.stdout, /lightrsi openclaw clean --require-tty --session/);

    const binDir = join(extractDir, "bin");
    const homeDir = join(extractDir, "home");
    const installEnvironment = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      LIGHTRSI_BIN_DIR: binDir,
    };
    await execFileAsync(process.execPath, [join(installedDir, "dist", "install-cli.js")], {
      env: installEnvironment,
    });
    assert.deepEqual(await readFile(join(binDir, "lightrsi")), await readFile(cliPath));
    assert.deepEqual(await readFile(join(binDir, "lightmem2")), await readFile(cliPath));
    if (process.platform === "win32") {
      const launcher = await readFile(join(binDir, "lightrsi.cmd"), "ascii");
      const powerShellLauncher = await readFile(join(binDir, "lightrsi.ps1"));
      assert.match(launcher, /powershell\.exe .*"%~dpn0\.ps1" %\*/i);
      assert.deepEqual([...powerShellLauncher.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      const windowsPowerShell = join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const launcherPath = join(binDir, "lightrsi.cmd").replaceAll("'", "''");
      const installedHelp = await execFileAsync(windowsPowerShell, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `& '${launcherPath}' --help`,
      ], { env: installEnvironment });
      assert.match(installedHelp.stdout, /lightrsi openclaw clean --require-tty --session/);
    }

    const hooks = plugin.__testHooks;
    const tools = [
      { type: "function", function: { name: "read" } },
      { type: "function", function: { name: "write" } },
    ];
    const makePayload = (userText: string) => ({
      model: "tokenpilot/gpt-5.4-mini",
      instructions: "Stable root prompt.",
      input: [
        {
          role: "developer",
          content: "Runtime: agent=test-agent | host=demo\nYour working directory is: /tmp/demo\n\nDeveloper prompt",
        },
        { role: "user", content: userText },
      ],
      tools,
    });
    const payloadA = makePayload("Keep exact user text A.");
    const payloadB = makePayload("Keep exact user text B.");
    const rewriteA = hooks.rewritePayloadForStablePrefix(payloadA, payloadA.model, {
      dynamicContextTarget: "developer",
    });
    const rewriteB = hooks.rewritePayloadForStablePrefix(payloadB, payloadB.model, {
      dynamicContextTarget: "developer",
    });
    assert.equal(rewriteA.promptCacheKey, rewriteB.promptCacheKey);
    assert.equal(payloadA.input[1].content, "Keep exact user text A.");
    assert.deepEqual(payloadA.tools, tools);

    const prepared = await hooks.prepareProxyRequest({
      cfg: hooks.normalizeConfig({
        moduleEnablement: { stabilizer: true, reduction: false, eviction: false },
        proxyMode: { pureForward: false },
      }),
      payload: makePayload("Keep exact user text A."),
      dynamicContextTarget: "developer",
    });
    assert.equal(prepared.payload.input[1].content, "Keep exact user text A.");
    assert.deepEqual(prepared.payload.tools, tools);
    const preparedAgain = await hooks.prepareProxyRequest({
      cfg: hooks.normalizeConfig({
        moduleEnablement: { stabilizer: true, reduction: false, eviction: false },
        proxyMode: { pureForward: false },
      }),
      payload: makePayload("Keep exact user text B."),
      dynamicContextTarget: "developer",
    });
    assert.equal(
      prepared.requestEnvelope.metadata?.promptCacheKey,
      preparedAgain.requestEnvelope.metadata?.promptCacheKey,
    );
  } finally {
    if (archivePath) await rm(archivePath, { force: true });
    await rm(staleDistPath, { force: true });
    await rm(extractDir, { recursive: true, force: true });
  }
});

test("release installer creates WSL-local launchers when only node.exe is available", async () => {
  await withTempDir("tokenpilot-release-wsl-cli-", async (root) => {
    const pluginDir = join(root, "plugin");
    const distDir = join(pluginDir, "dist");
    const binDir = join(root, "bin");
    const fakeTools = join(root, "tools");
    const nodeLog = join(root, "node-args.txt");
    await mkdir(distDir, { recursive: true });
    await mkdir(fakeTools, { recursive: true });
    await writeFile(join(distDir, "install-cli.js"), "// fixture\n", "utf8");
    await writeFile(join(distDir, "lightrsi.js"), "// fixture\n", "utf8");
    await writeFile(
      join(fakeTools, "node.exe"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${shellPath(nodeLog)}\n`,
      "utf8",
    );
    await writeFile(
      join(fakeTools, "wslpath"),
      "#!/usr/bin/env bash\nprintf '%s\\n' 'C:\\\\wsl$\\\\Ubuntu\\\\plugin\\\\dist\\\\lightrsi.js'\n",
      "utf8",
    );
    await chmod(join(fakeTools, "node.exe"), 0o755);
    await chmod(join(fakeTools, "wslpath"), 0o755);

    await runReleaseScript(root, [
      `INSTALLED_PLUGIN_PATH=${shellPath(pluginDir)}`,
      `LIGHTRSI_BIN_DIR=${shellPath(binDir)}`,
      `PATH=${shellPath(fakeTools)}:/usr/bin:/bin`,
      "install_bundled_cli",
      `PATH=${shellPath(fakeTools)}:/usr/bin:/bin ${shellPath(join(binDir, "lightrsi"))} --help`,
    ]);

    const launcher = await readFile(join(binDir, "lightrsi"), "utf8");
    assert.match(launcher, /^#!\/bin\/sh\nexec node\.exe /);
    assert.equal(existsSync(join(binDir, "lightmem2")), true);
    assert.match(await readFile(nodeLog, "utf8"), /^C:\\\\wsl\$\\\\Ubuntu\\\\plugin\\\\dist\\\\lightrsi\.js\n--help\n$/);
  });
});

test("release configuration does not require a working python3 command", async () => {
  await withTempDir("tokenpilot-release-config-", async (root) => {
    const configPath = join(root, "openclaw.json");
    const fakeTools = join(root, "tools");
    await mkdir(fakeTools, { recursive: true });
    await writeFile(join(fakeTools, "python3"), "#!/usr/bin/env bash\nexit 49\n", "utf8");
    await chmod(join(fakeTools, "python3"), 0o755);
    await writeFile(configPath, JSON.stringify({
      plugins: {
        allow: ["other-plugin"],
        entries: {},
      },
    }), "utf8");

    await runReleaseScript(root, [
      `CONFIG_PATH=${shellPath(configPath)}`,
      `PATH=${shellPath(fakeTools)}:"$PATH"`,
      "sanitize_plugin_config 1",
    ]);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.plugins.slots.contextEngine, "tokenpilot");
    assert.deepEqual(config.plugins.allow, ["other-plugin", "tokenpilot"]);
    assert.equal(config.plugins.entries.tokenpilot.enabled, true);
    assert.equal(config.plugins.entries.tokenpilot.config.proxyAutostart, false);
    if (process.platform === "win32") {
      assert.match(config.plugins.entries.tokenpilot.config.stateDir, /^[A-Za-z]:[\\/]/);
    }
    assert.equal(config.tools.profile, "coding");
    assert.deepEqual(config.tools.alsoAllow, ["memory_fault_recover"]);
  });
});

test("release pre-install configuration removes the managed entry and repairs elevated allowFrom", async () => {
  await withTempDir("tokenpilot-release-prepare-", async (root) => {
    const configPath = join(root, "openclaw.json");
    await writeFile(configPath, JSON.stringify({
      plugins: {
        allow: ["tokenpilot", "other-plugin"],
        entries: { tokenpilot: { enabled: true }, other: { enabled: true } },
      },
      tools: {
        elevated: {
          allowFrom: { discord: true, slack: false, existing: ["exec", "read"] },
        },
      },
    }), "utf8");

    await runReleaseScript(root, [
      `CONFIG_PATH=${shellPath(configPath)}`,
      "prepare_config_for_install",
    ]);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(config.plugins.allow, ["other-plugin"]);
    assert.equal(config.plugins.entries.tokenpilot, undefined);
    assert.deepEqual(config.plugins.entries.other, { enabled: true });
    assert.deepEqual(config.tools.elevated.allowFrom, {
      discord: ["exec"],
      slack: [],
      existing: ["exec", "read"],
    });
  });
});

test("release configuration fails closed without overwriting an invalid existing schema", async () => {
  await withTempDir("tokenpilot-release-invalid-config-", async (root) => {
    const configPath = join(root, "openclaw.json");
    const original = '{"plugins":"preserve-this-invalid-value"}\n';
    await writeFile(configPath, original, "utf8");
    await assert.rejects(runReleaseScript(root, [
      `CONFIG_PATH=${shellPath(configPath)}`,
      "sanitize_plugin_config 1",
    ]));
    assert.equal(await readFile(configPath, "utf8"), original);
  });
});

test("release configuration preserves Python integer and truthiness semantics", async () => {
  const helper = join(packageDir, "scripts", "configure-release.cjs");
  const helperArgs = [helper, "sanitize", "1", "", "", "C:/state", "1"];
  for (const invalidPort of ["0x10", "1e2"]) {
    await assert.rejects(execWithInput(process.execPath, helperArgs, JSON.stringify({
      plugins: {
        entries: { tokenpilot: { config: { proxyPort: invalidPort } } },
      },
    })));
  }

  const output = await execWithInput(process.execPath, helperArgs, JSON.stringify({
    plugins: {
      entries: {
        tokenpilot: {
          config: {
            debugTapProviderTraffic: {},
            hooks: { beforeToolCall: [] },
            contextEngine: { enabled: {} },
            modules: { stabilizer: [] },
            reduction: {
              passes: { htmlSlimming: {} },
              passOptions: { formatSlimming: { enabled: [] } },
            },
          },
        },
      },
    },
  }));
  const config = JSON.parse(output).plugins.entries.tokenpilot.config;
  assert.equal(config.debugTapProviderTraffic, false);
  assert.equal(config.hooks.beforeToolCall, false);
  assert.equal(config.contextEngine.enabled, false);
  assert.equal(config.modules.stabilizer, false);
  assert.equal(config.reduction.passes.htmlSlimming, false);
  assert.equal(config.reduction.passOptions.formatSlimming.enabled, false);
});
