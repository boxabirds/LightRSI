import { build } from "esbuild";
import { join } from "node:path";

async function main() {
  await build({
    entryPoints: {
      extension: "src/extension.ts",
      "install-pi": "scripts/install-pi.ts",
      "uninstall-pi": "scripts/uninstall-pi.ts",
      "doctor-pi": "scripts/doctor-pi.ts",
    },
    bundle: true,
    // ../shared/canonical has no node_modules of its own; resolve workspace deps from here.
    nodePaths: [join(__dirname, "node_modules")],
    outdir: "dist",
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: true,
    minify: false,
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
