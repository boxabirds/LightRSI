#!/usr/bin/env node

const { existsSync, readFileSync } = require("node:fs");

const MODE_PRESET = {
  triggerMinChars: 2200,
  maxToolChars: 1200,
  eviction: false,
  taskStateEstimator: false,
  passes: {
    readStateCompaction: true,
    toolPayloadTrim: true,
    htmlSlimming: true,
    execOutputTruncation: true,
    agentsStartupOptimization: true,
  },
  passOptions: {
    formatSlimming: true,
    formatCleaning: true,
    pathTruncation: true,
    imageDownsample: true,
    lineNumberStrip: true,
  },
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordAt(parent, key) {
  if (!Object.prototype.hasOwnProperty.call(parent, key)) parent[key] = {};
  if (!isRecord(parent[key])) throw new Error(`invalid_record:${key}`);
  return parent[key];
}

function normalizedRecordAt(parent, key) {
  if (!isRecord(parent[key])) parent[key] = {};
  return parent[key];
}

function pythonTruthy(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function integerOr(value, fallback, minimum) {
  const selected = pythonTruthy(value) ? value : fallback;
  let numeric;
  if (typeof selected === "boolean") {
    numeric = Number(selected);
  } else if (typeof selected === "number") {
    numeric = Math.trunc(selected);
  } else if (typeof selected === "string" && /^[+-]?[0-9]+$/u.test(selected.trim())) {
    numeric = Number(selected.trim());
  } else {
    throw new Error(`invalid_integer:${String(selected)}`);
  }
  if (!Number.isSafeInteger(numeric)) throw new Error(`invalid_integer:${String(selected)}`);
  return minimum === undefined ? numeric : Math.max(minimum, numeric);
}

function textOr(value, fallback) {
  const selected = pythonTruthy(value) ? value : fallback;
  if (typeof selected === "string" || typeof selected === "number") return String(selected);
  if (typeof selected === "boolean") return selected ? "True" : "False";
  throw new Error(`invalid_text:${String(selected)}`);
}

function valueOrDefault(record, key, fallback) {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : fallback;
}

function normalizePassOptions(value) {
  const options = isRecord(value) ? value : {};
  return Object.fromEntries(Object.entries(MODE_PRESET.passOptions).map(([key, fallback]) => {
    const option = isRecord(options[key]) ? options[key] : {};
    return [key, { enabled: pythonTruthy(valueOrDefault(option, "enabled", fallback)) }];
  }));
}

function sanitize(config, params) {
  const plugins = recordAt(config, "plugins");
  const slots = recordAt(plugins, "slots");
  if (params.postInstall) slots.contextEngine = "tokenpilot";

  const load = plugins.load;
  if (isRecord(load) && Array.isArray(load.paths)) {
    const paths = load.paths.filter((item) => (
      typeof item === "string"
      && item !== ""
      && !params.pluginPathsToRemove.has(item)
      && (!params.checkPathExists || existsSync(item))
    ));
    if (paths.length > 0) load.paths = paths;
    else delete plugins.load;
  }

  if (Array.isArray(plugins.allow)) {
    const allow = plugins.allow.filter((item) => item !== "tokenpilot");
    if (params.postInstall && !allow.includes("tokenpilot")) allow.push("tokenpilot");
    plugins.allow = allow;
  }

  const entries = recordAt(plugins, "entries");
  if (params.postInstall) {
    const tokenpilot = recordAt(entries, "tokenpilot");
    tokenpilot.enabled = true;
    const pluginConfig = recordAt(tokenpilot, "config");
    const allowedTopLevel = new Set([
      "enabled", "logLevel", "proxyAutostart", "proxyPort", "proxyBaseUrl", "proxyApiKey",
      "stateDir", "debugTapProviderTraffic", "debugTapPath", "proxyMode", "hooks",
      "contextEngine", "ux", "modules", "eviction", "reduction", "taskStateEstimator", "memory",
    ]);
    for (const key of Object.keys(pluginConfig)) {
      if (!allowedTopLevel.has(key)) delete pluginConfig[key];
    }

    pluginConfig.enabled = true;
    pluginConfig.logLevel = textOr(pluginConfig.logLevel, "info");
    pluginConfig.proxyAutostart = false;
    pluginConfig.proxyPort = integerOr(pluginConfig.proxyPort, 17667);
    pluginConfig.debugTapProviderTraffic = pythonTruthy(
      valueOrDefault(pluginConfig, "debugTapProviderTraffic", false),
    );
    if (typeof pluginConfig.stateDir !== "string" || !pluginConfig.stateDir.trim()) {
      pluginConfig.stateDir = params.defaultStateDir;
    }

    const proxyMode = isRecord(pluginConfig.proxyMode) ? pluginConfig.proxyMode : {};
    pluginConfig.proxyMode = {
      pureForward: pythonTruthy(valueOrDefault(proxyMode, "pureForward", false)),
    };

    const hooks = isRecord(pluginConfig.hooks) ? pluginConfig.hooks : {};
    pluginConfig.hooks = {
      beforeToolCall: pythonTruthy(valueOrDefault(hooks, "beforeToolCall", true)),
      toolResultPersist: pythonTruthy(valueOrDefault(hooks, "toolResultPersist", false)),
      dynamicContextTarget: String(hooks.dynamicContextTarget ?? "developer").trim().toLowerCase() === "user"
        ? "user"
        : "developer",
    };

    const contextEngine = isRecord(pluginConfig.contextEngine) ? pluginConfig.contextEngine : {};
    pluginConfig.contextEngine = {
      enabled: pythonTruthy(valueOrDefault(contextEngine, "enabled", true)),
      pruneThresholdChars: integerOr(contextEngine.pruneThresholdChars, 100000, 10000),
      keepRecentToolResults: integerOr(contextEngine.keepRecentToolResults, 5, 0),
      placeholder: textOr(contextEngine.placeholder, "[pruned]"),
    };

    const ux = isRecord(pluginConfig.ux) ? pluginConfig.ux : {};
    pluginConfig.ux = { details: pythonTruthy(valueOrDefault(ux, "details", false)) };

    const modules = isRecord(pluginConfig.modules) ? pluginConfig.modules : {};
    pluginConfig.modules = {
      stabilizer: pythonTruthy(valueOrDefault(modules, "stabilizer", true)),
      policy: pythonTruthy(valueOrDefault(modules, "policy", true)),
      reduction: pythonTruthy(valueOrDefault(modules, "reduction", true)),
      eviction: pythonTruthy(valueOrDefault(modules, "eviction", false)),
    };

    const eviction = isRecord(pluginConfig.eviction) ? pluginConfig.eviction : {};
    pluginConfig.eviction = {
      enabled: pythonTruthy(valueOrDefault(eviction, "enabled", false)),
      policy: textOr(eviction.policy, "noop"),
      maxCandidateBlocks: integerOr(eviction.maxCandidateBlocks, 128, 1),
      minBlockChars: integerOr(eviction.minBlockChars, 256, 0),
      replacementMode: String(eviction.replacementMode ?? "").trim() === "drop"
        ? "drop"
        : "pointer_stub",
    };

    const reduction = isRecord(pluginConfig.reduction) ? pluginConfig.reduction : {};
    reduction.engine = "layered";
    reduction.triggerMinChars = integerOr(reduction.triggerMinChars, MODE_PRESET.triggerMinChars, 256);
    reduction.maxToolChars = integerOr(reduction.maxToolChars, MODE_PRESET.maxToolChars, 256);
    const passes = isRecord(reduction.passes) ? reduction.passes : {};
    reduction.passes = Object.fromEntries(Object.entries(MODE_PRESET.passes).map(
      ([key, fallback]) => [key, pythonTruthy(valueOrDefault(passes, key, fallback))],
    ));
    reduction.passOptions = normalizePassOptions(reduction.passOptions);
    pluginConfig.reduction = reduction;

    const taskStateEstimator = isRecord(pluginConfig.taskStateEstimator)
      ? pluginConfig.taskStateEstimator
      : {};
    taskStateEstimator.enabled = pythonTruthy(
      valueOrDefault(taskStateEstimator, "enabled", MODE_PRESET.taskStateEstimator),
    );
    pluginConfig.taskStateEstimator = taskStateEstimator;
    pluginConfig.modules.eviction = pythonTruthy(
      valueOrDefault(pluginConfig.modules, "eviction", MODE_PRESET.eviction),
    );
    pluginConfig.eviction.enabled = pythonTruthy(
      valueOrDefault(pluginConfig.eviction, "enabled", MODE_PRESET.eviction),
    );
  }

  if (Object.keys(entries).length === 0) delete plugins.entries;

  const tools = normalizedRecordAt(config, "tools");
  if (typeof tools.profile !== "string" || !tools.profile.trim()) tools.profile = "coding";
  if (Array.isArray(tools.allow)) {
    if (!tools.allow.includes("memory_fault_recover")) tools.allow.push("memory_fault_recover");
  } else if (Array.isArray(tools.alsoAllow)) {
    if (!tools.alsoAllow.includes("memory_fault_recover")) {
      tools.alsoAllow.push("memory_fault_recover");
    }
  } else {
    tools.alsoAllow = ["memory_fault_recover"];
  }
}

function prepare(config) {
  const plugins = recordAt(config, "plugins");
  if (Array.isArray(plugins.allow)) {
    const allow = plugins.allow.filter((item) => item !== "tokenpilot");
    if (allow.length > 0) plugins.allow = allow;
    else delete plugins.allow;
  }
  if (isRecord(plugins.entries)) {
    delete plugins.entries.tokenpilot;
    if (Object.keys(plugins.entries).length === 0) delete plugins.entries;
  }

  const elevated = isRecord(config.tools) && isRecord(config.tools.elevated)
    ? config.tools.elevated
    : undefined;
  if (elevated && isRecord(elevated.allowFrom)) {
    for (const [key, value] of Object.entries(elevated.allowFrom)) {
      if (typeof value === "boolean") elevated.allowFrom[key] = value ? ["exec"] : [];
    }
  }
}

const [
  operation,
  postInstallRaw,
  devPluginPath = "",
  installedPluginPath = "",
  defaultStateDir = "",
  checkPathExistsRaw = "1",
  alternateDevPluginPath = "",
  alternateInstalledPluginPath = "",
] = process.argv.slice(2);
const config = JSON.parse(readFileSync(0, "utf8"));
if (!isRecord(config)) throw new Error("openclaw_config_must_be_an_object");

if (operation === "sanitize") {
  sanitize(config, {
    postInstall: postInstallRaw === "1",
    pluginPathsToRemove: new Set([
      devPluginPath,
      installedPluginPath,
      alternateDevPluginPath,
      alternateInstalledPluginPath,
    ].filter(Boolean)),
    checkPathExists: checkPathExistsRaw === "1",
    defaultStateDir,
  });
} else if (operation === "prepare") {
  prepare(config);
} else {
  throw new Error(`unknown_release_config_operation:${String(operation)}`);
}

process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
