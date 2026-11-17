#!/usr/bin/env node
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

function getArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

const targetHome = getArgValue("--target-home") || homedir();
const pluginName = "jev-openrouter";
const pluginDest = join(targetHome, ".gemini", "config", "plugins", pluginName);
const dataDir = join(targetHome, ".gemini", "config", "plugin-data", pluginName);
const distEntry = join(rootDir, "dist", "mcp-server.mjs");

if (!existsSync(distEntry)) {
  console.error("Missing dist/mcp-server.mjs. Run `npm run build` first.");
  process.exit(1);
}

mkdirSync(join(targetHome, ".gemini", "config", "plugins"), { recursive: true });
mkdirSync(dataDir, { recursive: true });

if (existsSync(pluginDest)) {
  rmSync(pluginDest, { recursive: true, force: true });
}
mkdirSync(pluginDest, { recursive: true });

const copyTargets = [
  "plugin.json",
  "mcp_config.json",
  "README.md",
  "LICENSE",
  "assets",
  "dist",
  "rules",
  "skills",
  "agents",
  "scripts",
];

for (const item of copyTargets) {
  const src = join(rootDir, item);
  if (existsSync(src)) {
    cpSync(src, join(pluginDest, item), { recursive: true });
  }
}

chmodSync(join(pluginDest, "dist", "mcp-server.mjs"), 0o755);

// Optionally materialize standalone ~/.gemini/config/mcp_config.json entry if user passes --write-global-mcp
if (process.argv.includes("--write-global-mcp")) {
  const globalMcpPath = join(targetHome, ".gemini", "config", "mcp_config.json");
  let existing = { mcpServers: {} };
  if (existsSync(globalMcpPath)) {
    const rawGlobal = readFileSync(globalMcpPath, "utf8").trim();
    if (rawGlobal.length > 0) {
      try {
        existing = JSON.parse(rawGlobal);
        if (!existing.mcpServers || typeof existing.mcpServers !== "object") {
          existing.mcpServers = {};
        }
      } catch (err) {
        console.error(`Existing ${globalMcpPath} contains invalid JSON; refusing to overwrite: ${err.message}`);
        process.exit(1);
      }
    }
  }
  existing.mcpServers["jev-openrouter_jev"] = {
    command: "node",
    args: [join(pluginDest, "dist", "mcp-server.mjs")],
    env: {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "${OPENROUTER_API_KEY}",
      PLUGIN_ROOT: pluginDest,
      PLUGIN_DATA: dataDir,
    },
    timeoutSeconds: 180,
    tools: {
      jev_decide: {
        eager: true,
      },
      jev_run_recipe: {
        eager: true,
      },
    },
  };
  writeFileSync(globalMcpPath, JSON.stringify(existing, null, 2) + "\n", "utf8");
}

console.log(
  JSON.stringify(
    {
      installed: true,
      pluginName,
      pluginDest,
      dataDir,
      nextSteps: [
        "Set OPENROUTER_API_KEY in Antigravity Customizations > Installed > TypeSafe Jev on OpenRouter (or export OPENROUTER_API_KEY).",
        "Or run: agy plugin install " + rootDir,
      ],
    },
    null,
    2,
  ),
);
