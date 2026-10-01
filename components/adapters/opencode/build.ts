import { build } from "esbuild";
import { join } from "node:path";

const shared = {
  bundle: true,
  // ../shared/canonical has no node_modules of its own; resolve workspace deps from here.
  nodePaths: [join(__dirname, "node_modules")],
  platform: "node" as const,
  target: "node20",
  sourcemap: true,
  minify: false,
  logLevel: "info" as const,
  logOverride: { "empty-import-meta": "silent" as const },
};

async function main() {
  // OpenCode (Bun) imports plugins as ES modules. Bundled CommonJS dependencies
  // still need `require`, `__filename` and `__dirname`, so provide them.
  await build({
    ...shared,
    entryPoints: { plugin: "src/plugin.ts" },
    outdir: "dist",
    format: "esm",
    outExtension: { ".js": ".mjs" },
    banner: {
      js: [
        'import { createRequire as __tpCreateRequire } from "node:module";',
        'import { fileURLToPath as __tpFileURLToPath } from "node:url";',
        'import { dirname as __tpDirname } from "node:path";',
        "const require = __tpCreateRequire(import.meta.url);",
        "const __filename = __tpFileURLToPath(import.meta.url);",
        "const __dirname = __tpDirname(__filename);",
      ].join("\n"),
    },
  });
  await build({
    ...shared,
    entryPoints: {
      "install-opencode": "scripts/install-opencode.ts",
      "uninstall-opencode": "scripts/uninstall-opencode.ts",
      "doctor-opencode": "scripts/doctor-opencode.ts",
    },
    outdir: "dist",
    format: "cjs",
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
