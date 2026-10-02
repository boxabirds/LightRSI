import { build } from "esbuild";
import { join } from "node:path";

async function main() {
  await build({
    entryPoints: ["src/cli.ts"],
    bundle: true,
    // adapters/shared/canonical (pulled in by the pi/OpenCode hosts) has no node_modules
    // of its own; resolve its workspace dependencies through an adapter that declares them.
    nodePaths: [join(__dirname, "node_modules"), join(__dirname, "..", "..", "adapters", "opencode", "node_modules")],
    outfile: "dist/cli.js",
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
    logLevel: "info",
    logOverride: {
      "empty-import-meta": "silent",
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
