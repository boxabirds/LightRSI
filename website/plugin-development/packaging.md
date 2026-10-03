# Packaging Plugins

TokenPilot uses a **pnpm workspace** within the LightRSI monorepo.

Build commands from [CONTRIBUTING.md](https://github.com/zjunlp/LightRSI/blob/main/CONTRIBUTING.md):

| Command | Purpose |
| :-- | :-- |
| `pnpm install` | Install all workspace dependencies |
| `pnpm build` | Build all shared packages in the workspace |
| `pnpm lightrsi:build` | Build the standalone CLI surface |
| `pnpm lightrsi:install` | Install the CLI entrypoint globally |
| `pnpm --dir website docs:build` | Build the documentation site |

Adapter install scripts:

| Host | Install Command |
| :-- | :-- |
| OpenClaw | `pnpm component:install:tokenpilot:openclaw` |
| Codex CLI | `npm --prefix components/adapters/codex run install:codex` |
| Claude Code | `npm --prefix components/adapters/claude-code run install:claude-code` |
| pi | `npm --prefix components/adapters/pi run install:pi` |
| OpenCode | `npm --prefix components/adapters/opencode run install:opencode` |
| DeepSeek Harness | Build and pack `@lightrsi/deepseek-harness-adapter`, then add the `.tgz` through the Harness profile plugin installer; [commands](/hosts/deepseek-harness#install) |

The pi and OpenCode adapters ship as in-process integrations, so their install scripts write a host-loaded extension or plugin plus their own config, and do not configure a proxy or gateway.

## Related Pages

- [Testing Plugins](/plugin-development/testing) — verifying builds
- [Build Your First Plugin](/plugin-development/build-your-first-plugin) — getting started
