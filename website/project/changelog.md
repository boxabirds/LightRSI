# Changelog

## pi and OpenCode Support (2026-10-02)

- TokenPilot support for **OpenCode** as an in-process v1 plugin plus the shared recovery MCP server, registered as `mcp.tokenpilot_memory_fault_recover`.
- TokenPilot support for **pi** as an in-process extension with a native `memory_fault_recover` tool, because pi has no MCP.
- Eviction is opt-in and off by default on both hosts, and neither adapter exposes `mode aggressive`.
- pi installs an extension loader at `~/.pi/agent/extensions/tokenpilot/index.js` and does not modify pi's own config files.
- OpenCode backs up `opencode.json` before adding that entry; a non-plain-JSON `opencode.json` or an `opencode.jsonc` is never rewritten, and the MCP snippet is printed instead.
- Both hosts are driven through the shared `lightrsi pi ...` and `lightrsi opencode ...` CLI surface.
- The host-neutral eviction core now lives in `@lightrsi/eviction`, so adapters share it instead of copying it (PRs #95, #96, #98).

## OpenClaw Cleaner Terminal Entry (2026-09-28)

- `/lightrsi clean` now prints a same-terminal arrow-key launcher bound to the exact current OpenClaw session; it does not guess the most recently active session.
- The OpenClaw release archive now bundles the native plugin and `lightrsi` CLI, with installation support for Windows, WSL, and Git Bash.
- Cleaner selection still records `scheduled`; the next ordinary OpenClaw request performs the canonical rewrite, and terminal receipts prevent replay.
- Release hardening protects shell commands and terminal output from unsafe session IDs and control characters, and preserves the existing configuration if an update fails.

## Context Cleaner Workflow Updates (2026-09-22)

- DeepSeek Harness exposes native `/tokenpilot-clean` analysis, explicit selection, status, and cancellation. Accepted selections execute on the next ordinary agent request; the shared external CLI is not yet registered.
- OpenClaw now persists an approved selection as `scheduled` and executes it on the next ordinary request. Native commands and the external CLI share plans and receipts.
- OpenClaw and DSH native commands return text plans; this does not imply Host-terminal arrow-key selection support.

## Context Cleaner (2026-09-16)

- User-approved task-level context cleaning is available through [Context Cleaner](/user-guide/context-cleaner).
- The initial OpenClaw integration used immediate canonical apply (superseded by the scheduled workflow above); Codex and Claude Code schedule approved selections for a subsequent eligible request.
- Plans expose protected tasks and accounting; receipts distinguish analysis, scheduling, and application.
- Codex offers a terminal selector and a host-rendered MCP form. Claude Code's analysis skill leaves task selection and approval to the user.

## DeepSeek Harness Support (2026-09-16)

- TokenPilot is available as the native `tokenpilot-dsh` Cordis plugin.
- Opt-in context eviction uses task-state estimation and persistent task state, running before native Harness compaction by default.
- `/tokenpilot-status` reports estimator activity, candidate work, application evidence, and deferrals without starting a model turn.
- See [DeepSeek Harness](/hosts/deepseek-harness) for installation and configuration.

## v0.1.0 (2026-06-28)

- **Initial release** of LightRSI platform and TokenPilot plugin
- TokenPilot support for **OpenClaw** (native plugin)
- TokenPilot support for **Codex CLI** (local proxy + hooks)
- TokenPilot support for **Claude Code** (local gateway + MCP)
- Stable prefix, context reduction, and context eviction subsystems
- `lightrsi` standalone CLI
- Visual inspector (browser-based dashboard)
- Benchmark reproduction moved to the separate [TokenPilot experiment repository](https://github.com/Xubqpanda/TokenPilot)
- [TokenPilot paper](https://arxiv.org/abs/2606.17016) published

## Next

- [Changelog](/project/changelog) — what's coming
- [GitHub Releases](https://github.com/zjunlp/LightRSI/releases)
