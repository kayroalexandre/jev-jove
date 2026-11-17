import { chmodSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const outFile = resolve(rootDir, "dist/mcp-server.mjs");

mkdirSync(dirname(outFile), { recursive: true });

await build({
  entryPoints: [resolve(rootDir, "src/mcp/server.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: false,
  minify: false,
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __jevCreateRequire } from "node:module";',
      "const require = __jevCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});

chmodSync(outFile, 0o755);
