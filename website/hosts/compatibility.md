# Host Compatibility

TokenPilot integrates with OpenClaw, Codex CLI, Claude Code, DeepSeek Harness, and OpenCode. Each integration has a different boundary, so capabilities and setup instructions are documented per host.

## Supported Hosts

| Host | Integration | Adapter Location |
| :-- | :-- | :-- |
| [OpenClaw](./openclaw) | Native plugin slot | `components/adapters/openclaw/` |
| [Codex CLI](./codex) | Local proxy + hooks | `components/adapters/codex/` |
| [Claude Code](./claude-code) | Local gateway + MCP | `components/adapters/claude-code/` |
| [DeepSeek Harness](./deepseek-harness) | Native Cordis plugin + optional context eviction + session status | `components/adapters/deepseek-harness/` |
| [OpenCode](./opencode) | In-process v1 plugin + recovery MCP | `components/adapters/opencode/` |

DeepSeek Harness provides opt-in context eviction and the read-only `/tokenpilot-status` command. It uses Harness's own transport and compaction, with separate profile configuration. See the [DeepSeek Harness guide](./deepseek-harness) for installation, required settings, and troubleshooting.

The matrix below distinguishes shared product interfaces from host-native capabilities. `—` means the listed TokenPilot interface is not provided by that adapter; it does not describe unrelated features of the host itself.

## TokenPilot Host Feature Matrix

| Feature | OpenClaw | Codex | Claude Code | DeepSeek Harness | OpenCode |
| :-- | :-- | :-- | :-- | :-- | :-- |
| Stable Prefix | ✅ | ✅ | ✅ | — | ✅ (`developer` target only) |
| Context Reduction | ✅ | ✅ | ✅ | — | ✅ |
| Automatic Context Eviction | ✅ | Opt-in response-chain rebase¹ | — | Opt-in; estimator and durable state required | Opt-in; durable request overlay³ |
| User-approved [Context Cleaner](/user-guide/context-cleaner) | Scheduled canonical apply | Scheduled response-chain rebase | Scheduled request overlay | Native `/tokenpilot-clean`; scheduled surface transaction | — |
| Visual Inspector | ✅ | ✅ | ✅ | — | ✅ |
| Session Reports (`report`) | ✅ | ✅ | ✅ | —; native status instead | ✅ |
| Session Status | `/lightrsi status` or CLI | `lightrsi codex status` | `lightrsi claude-code status` | `/tokenpilot-status`² | `lightrsi opencode status` |
| Shared Standalone CLI | ✅ | ✅ | ✅ | —; Harness plugin interface | ✅ |
| MCP Recovery Server | ✅ | ✅ | ✅ | — | ✅ |
| `mode conservative` | ✅ | ✅ | ✅ | —; profile configuration | ✅ |
| `mode normal` | ✅ | ✅ | ✅ | —; profile configuration | ✅ |
| `mode aggressive` | ✅ | — | — | —; profile configuration | — |
| Proxy / Gateway Startup | Gateway restart | SessionStart hook | SessionStart hook | Not needed; Harness owns transport | Not needed; in-process |

¹ The [Codex adapter README](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/codex/README.md#task-state-estimator-bridge-pr-b) documents opt-in automatic eviction with both `taskStateEstimator.enabled` and `contextRewrite.enabled`. This does not provide the OpenClaw `eviction` commands or `aggressive` mode.

² DeepSeek Harness registers its status command when the profile provides command and session projection services. Its eviction pass runs before native Harness compaction by default. See [DeepSeek Harness](/hosts/deepseek-harness) for configuration and status interpretation.

³ OpenCode eviction uses the shared canonical-surface core (`@lightrsi/eviction`, lifted from the DeepSeek Harness adapter). It needs `modules.eviction`, `eviction.enabled` and `taskStateEstimator.{baseUrl,model,apiKey}`. Evicted content is archived and recoverable with `memory_fault_recover`.
