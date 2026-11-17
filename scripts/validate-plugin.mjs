#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

const strict = process.argv.includes("--strict");
const asJson = process.argv.includes("--json");

/** @type {Array<{severity: "error"|"warning"|"note", file?: string, code: string, message: string}>} */
const findings = [];

function add(severity, file, code, message) {
  findings.push({ severity, file, code, message });
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return null;
  const raw = match[1];
  const lines = raw.split(/\r?\n/);
  /** @type {Record<string, unknown>} */
  const data = {};
  let currentKey = null;
  let multiline = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (multiline) {
      if (/^\s+/.test(line) || line.trim() === "") {
        multiline.lines.push(line.replace(/^\s+/, ""));
        continue;
      } else {
        data[multiline.key] = multiline.lines.join(" ").trim();
        multiline = null;
      }
    }

    if (currentKey && /^\s+-\s+/.test(line)) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = [];
      data[currentKey].push(line.replace(/^\s+-\s+/, "").trim());
      continue;
    }

    const kv = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    currentKey = key;

    if (val === ">-" || val === "|" || val === ">") {
      multiline = { key, lines: [] };
      continue;
    }
    if (val === "") {
      continue;
    }
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else if (val === "true") {
      data[key] = true;
      continue;
    } else if (val === "false") {
      data[key] = false;
      continue;
    }
    data[key] = val;
  }

  if (multiline) {
    data[multiline.key] = multiline.lines.join(" ").trim();
  }
  return data;
}

// 1. Validate plugin.json
const pluginJsonPath = join(rootDir, "plugin.json");
let manifest = null;
if (!existsSync(pluginJsonPath)) {
  add("error", "plugin.json", "MISSING_MANIFEST", "plugin.json is missing at plugin root.");
} else {
  try {
    manifest = JSON.parse(readFileSync(pluginJsonPath, "utf8"));
    const allowedKeys = new Set([
      "$schema",
      "name",
      "displayName",
      "description",
      "version",
      "disabled",
      "logo",
      "suggestedPrompts",
      "skills",
      "author",
      "homepage",
      "repository",
      "license",
      "keywords",
      "extensions",
    ]);
    for (const k of Object.keys(manifest)) {
      if (!allowedKeys.has(k)) {
        add("error", "plugin.json", "UNKNOWN_MANIFEST_PROPERTY", `Unexpected property '${k}' in plugin.json (additionalProperties: false).`);
      }
    }

    if (typeof manifest.name !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.name)) {
      add("error", "plugin.json", "INVALID_NAME", "manifest.name must match ^[a-z0-9]+(-[a-z0-9]+)*$.");
    }

    if (typeof manifest.displayName !== "string" || !manifest.displayName.trim()) {
      add("warning", "plugin.json", "MISSING_DISPLAY_NAME", "manifest.displayName is recommended for Marketplace.");
    } else {
      if (/^(Antigravity|Gemini|Claude|Cursor)\b/i.test(manifest.displayName)) {
        add("error", "plugin.json", "FORBIDDEN_DISPLAYNAME_PREFIX", "displayName cannot start with Antigravity/Gemini/Claude/Cursor.");
      }
      if (/\b(Plugin|MCP)$/i.test(manifest.displayName)) {
        add("warning", "plugin.json", "FORBIDDEN_DISPLAYNAME_SUFFIX", "displayName should omit trailing 'Plugin' or 'MCP'.");
      }
    }

    if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+/.test(manifest.version)) {
      add("warning", "plugin.json", "INVALID_VERSION", "manifest.version should be semver (e.g. 1.0.0).");
    }

    if (!manifest.logo || typeof manifest.logo !== "string") {
      add("warning", "plugin.json", "MISSING_LOGO", "manifest.logo is recommended.");
    } else {
      const logoFile = join(rootDir, manifest.logo);
      if (!existsSync(logoFile)) {
        add("error", manifest.logo, "LOGO_NOT_FOUND", `Logo path '${manifest.logo}' does not exist.`);
      } else if (manifest.logo.endsWith(".svg")) {
        const svg = readFileSync(logoFile, "utf8");
        if (!/viewBox=["']0 0 (\d+) \1["']/.test(svg)) {
          add("warning", manifest.logo, "SVG_NOT_SQUARE", "Logo SVG viewBox should be 1:1 square.");
        }
      }
    }

    if (Array.isArray(manifest.suggestedPrompts)) {
      if (manifest.suggestedPrompts.length > 3) {
        add("error", "plugin.json", "TOO_MANY_PROMPTS", "suggestedPrompts accepts at most 3 entries.");
      }
      for (const p of manifest.suggestedPrompts) {
        if (typeof p !== "string" || !/\S/.test(p)) {
          add("error", "plugin.json", "EMPTY_PROMPT", "Each suggestedPrompt must be a non-empty string.");
        }
      }
    }
  } catch (err) {
    add("error", "plugin.json", "INVALID_JSON", `Invalid JSON in plugin.json: ${err.message}`);
  }
}

// 2. Validate multi-tool accidental shadow files at root
for (const forbiddenRoot of [".mcp.json", "mcp.json", "AGENTS.md", "GEMINI.md", ".claude-plugin", ".cursor-plugin"]) {
  if (existsSync(join(rootDir, forbiddenRoot))) {
    add("warning", forbiddenRoot, "SHADOWED_OTHER_TOOL_FILE", `File '${forbiddenRoot}' at root triggers Antigravity multi-tool warnings.`);
  }
}

// 3. Validate mcp_config.json
const mcpConfigPath = join(rootDir, "mcp_config.json");
if (existsSync(mcpConfigPath)) {
  try {
    const mcpCfg = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
    if (mcpCfg.variables) {
      add("error", "mcp_config.json", "ROOT_VARIABLES", "Move 'variables' inside mcpServers.<server>.variables, not root.");
    }
    const servers = mcpCfg.mcpServers ?? {};
    for (const [srvName, srv] of Object.entries(servers)) {
      if ("type" in srv) {
        add("error", "mcp_config.json", "FORBIDDEN_SERVER_TYPE", `Remove 'type' property from mcpServers.${srvName}.`);
      }
      if (srv.env && ("PLUGIN_ROOT" in srv.env || "PLUGIN_DATA" in srv.env)) {
        add("error", "mcp_config.json", "DUPLICATED_PLUGIN_ENV", `Do not duplicate PLUGIN_ROOT or PLUGIN_DATA in mcpServers.${srvName}.env.`);
      }
      if (Array.isArray(srv.variables) && srv.variables.length > 0) {
        add("note", "mcp_config.json", "VARIABLES_ONBOARDING", `Server '${srvName}' declares ${srv.variables.length} onboarding variable(s); plugin installs disabled until configured.`);
      }
      if (Array.isArray(srv.args)) {
        for (const arg of srv.args) {
          if (typeof arg === "string" && arg.startsWith("${PLUGIN_ROOT}/")) {
            const relTarget = arg.slice("${PLUGIN_ROOT}/".length);
            const fullTarget = join(rootDir, relTarget);
            if (!existsSync(fullTarget)) {
              add("error", "mcp_config.json", "MISSING_ENTRYPOINT", `Referenced MCP entrypoint '${relTarget}' does not exist. Run npm run build.`);
            }
          }
        }
      }
    }
  } catch (err) {
    add("error", "mcp_config.json", "INVALID_JSON", `Invalid JSON in mcp_config.json: ${err.message}`);
  }
}

// 4. Validate rules/
const rulesDir = join(rootDir, "rules");
if (existsSync(rulesDir)) {
  for (const file of readdirSync(rulesDir)) {
    if (!file.endsWith(".md")) continue;
    const rel = `rules/${file}`;
    const raw = readFileSync(join(rulesDir, file), "utf8");
    if (file === "AGENTS.md" || file === "GEMINI.md") {
      if (!raw.trim()) add("warning", rel, "EMPTY_RULE", `${rel} is empty.`);
      continue;
    }
    const fm = parseFrontmatter(raw);
    if (!fm) {
      add("error", rel, "MISSING_RULE_FRONTMATTER", `${rel} requires YAML frontmatter with trigger.`);
      continue;
    }
    const validTriggers = new Set(["always_on", "model_decision", "glob", "manual"]);
    if (!validTriggers.has(String(fm.trigger))) {
      add("error", rel, "INVALID_RULE_TRIGGER", `${rel} trigger must be always_on|model_decision|glob|manual.`);
    }
    if (fm.trigger === "glob") {
      if (typeof fm.globs !== "string" || !fm.globs.trim()) {
        add("error", rel, "INVALID_RULE_GLOBS", `${rel} 'globs' MUST be a comma-separated string, NOT an array.`);
      }
    }
    if (fm.trigger === "model_decision" && typeof fm.description !== "string") {
      add("error", rel, "MISSING_RULE_DESCRIPTION", `${rel} with trigger=model_decision requires description.`);
    }
  }
}

// 5. Validate skills/
const skillsDir = join(rootDir, "skills");
if (existsSync(skillsDir)) {
  for (const dirName of readdirSync(skillsDir)) {
    const skillFolder = join(skillsDir, dirName);
    if (!statSync(skillFolder).isDirectory()) continue;
    const skillMd = join(skillFolder, "SKILL.md");
    const rel = `skills/${dirName}/SKILL.md`;
    if (!existsSync(skillMd)) {
      add("error", rel, "MISSING_SKILL_MD", `${rel} is missing.`);
      continue;
    }
    const fm = parseFrontmatter(readFileSync(skillMd, "utf8"));
    if (!fm) {
      add("error", rel, "MISSING_SKILL_FRONTMATTER", `${rel} is missing YAML frontmatter.`);
      continue;
    }
    if (fm.name !== dirName) {
      add("error", rel, "SKILL_NAME_MISMATCH", `Frontmatter name '${fm.name}' must match parent directory '${dirName}'.`);
    }
    if (typeof fm.description !== "string" || fm.description.length === 0 || fm.description.length > 1024) {
      add("error", rel, "INVALID_SKILL_DESCRIPTION", `${rel} description must be 1-1024 characters.`);
    }
  }
}

// 6. Validate agents/
const agentsDir = join(rootDir, "agents");
if (existsSync(agentsDir)) {
  for (const file of readdirSync(agentsDir)) {
    if (!file.endsWith(".md")) continue;
    const rel = `agents/${file}`;
    const fm = parseFrontmatter(readFileSync(join(agentsDir, file), "utf8"));
    if (!fm) {
      add("error", rel, "MISSING_AGENT_FRONTMATTER", `${rel} requires YAML frontmatter.`);
      continue;
    }
    if (typeof fm.name !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.name)) {
      add("error", rel, "INVALID_AGENT_NAME", `${rel} name must be kebab-case.`);
    }
    if (typeof fm.description !== "string" || !fm.description.trim()) {
      add("error", rel, "MISSING_AGENT_DESCRIPTION", `${rel} requires description.`);
    }
    if (fm.model && !["inherit", "flash_lite", "flash", "pro"].includes(String(fm.model))) {
      add("error", rel, "INVALID_AGENT_MODEL", `${rel} model must be inherit|flash_lite|flash|pro.`);
    }
  }
}

// 7. Validate scripts/ permissions (0755 executable check)
const scriptsDir = join(rootDir, "scripts");
if (existsSync(scriptsDir)) {
  for (const file of readdirSync(scriptsDir)) {
    const full = join(scriptsDir, file);
    if (!statSync(full).isFile()) continue;
    const mode = statSync(full).mode;
    if ((mode & 0o111) === 0) {
      add("warning", `scripts/${file}`, "SCRIPT_NOT_EXECUTABLE", `scripts/${file} should have executable 0755 permissions.`);
    }
  }
}

const errorCount = findings.filter((f) => f.severity === "error").length;
const warningCount = findings.filter((f) => f.severity === "warning").length;

if (asJson) {
  console.log(
    JSON.stringify(
      {
        manifest: "plugin.json",
        name: manifest?.name,
        version: manifest?.version,
        valid: errorCount === 0 && (!strict || warningCount === 0),
        errorCount,
        warningCount,
        findings,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`Antigravity Plugin Validation (${manifest?.name ?? "unknown"} v${manifest?.version ?? "?"})`);
  for (const f of findings) {
    console.log(`  [${f.severity.toUpperCase()}] ${f.file ?? ""} (${f.code}): ${f.message}`);
  }
  console.log(`Summary: ${errorCount} error(s), ${warningCount} warning(s).`);
}

if (errorCount > 0 || (strict && warningCount > 0)) {
  process.exit(1);
}
