# TypeSafe Jev on OpenRouter (`jev-openrouter`)

Google Antigravity **Plugin + MCP Server** for **TypeSafe Jev (System One)** running on **OpenRouter**, pre-configured with all current official TypeSafe recommendations (primitives, confidence math, 9 Model Jaggedness safeguards, all 10 official recipes/cookbooks, self-consistency/permutation testing, and automatic 1D temperature & SLA threshold calibration) and all official OpenRouter best practices (App Attribution, ZDR, latency routing, prompt/response caching, spend limits & retry semantics, fail-closed safety gating, and `typesafe/jev-router`).

---

## Quick Setup (Antigravity Desktop App / IDE / CLI)

1. Get your OpenRouter API key at **https://openrouter.ai/settings/keys** (no separate TypeSafe account needed).
2. Choose any installation method below (pre-bundled `dist/mcp-server.mjs` requires **only Node.js >= 20** — no `npm install` needed):

### Option A — Antigravity CLI (`agy`) (Windows / macOS / Linux)
```bash
agy plugin install https://github.com/kayroalexandre/jev-jove
agy plugin enable jev-openrouter
```
Or open **Antigravity Desktop > Customizations > Installed > TypeSafe Jev on OpenRouter**, toggle it on, and paste your **`OPENROUTER_API_KEY`** when prompted.

### Option B — Windows Desktop (1-Command PowerShell Installer)
Run in Windows PowerShell (`Win + X` > Terminal / PowerShell):
```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/kayroalexandre/jev-jove/main/scripts/install-windows.ps1 | iex"
```
This installs the full plugin cleanly into `%USERPROFILE%\.gemini\config\plugins\jev-openrouter` and optionally prompts (hidden input) to configure `%USERPROFILE%\.gemini\config\mcp_config.json` with your `OPENROUTER_API_KEY`. Restart/reload Antigravity Desktop afterwards.

### Option C — Manual / Local Clone Setup (`mcp_config.json`)
```bash
node scripts/install-local.mjs --write-global-mcp
```
Or open your global MCP config directly in the UI:
- **Antigravity Desktop App:** `Customizations > Installed > MCP Servers > Copy Config File Path`
- **Antigravity IDE:** Agent panel `…` > `MCP Servers` > `Manage MCP Servers` > `View raw config`

On Windows, add `"jev-openrouter_jev"` to `%USERPROFILE%\.gemini\config\mcp_config.json` (replace `YOUR_USER` and `sk-or-v1-...`):
```json
{
  "mcpServers": {
    "jev-openrouter_jev": {
      "command": "node",
      "args": [
        "C:\\Users\\YOUR_USER\\.gemini\\config\\plugins\\jev-openrouter\\dist\\mcp-server.mjs"
      ],
      "env": {
        "OPENROUTER_API_KEY": "sk-or-v1-...",
        "PLUGIN_ROOT": "C:\\Users\\YOUR_USER\\.gemini\\config\\plugins\\jev-openrouter",
        "PLUGIN_DATA": "C:\\Users\\YOUR_USER\\.gemini\\config\\plugin-data\\jev-openrouter"
      },
      "timeoutSeconds": 180,
      "tools": {
        "jev_decide": { "eager": true },
        "jev_run_recipe": { "eager": true }
      }
    }
  }
}
```

---

## Included Antigravity Components

- **Manifest & Zero-Install MCP Server**: [plugin.json](plugin.json), [mcp_config.json](mcp_config.json), standalone bundle [dist/mcp-server.mjs](dist/mcp-server.mjs)
- **8 MCP Tools (`jev` server)**:
  - `jev_decide` *(eager)* — Execute `noul`, `choice`, `score`, and `box` questions in parallel with pre-flight jaggedness linting, optional calibrated profile routing, ZDR/latency routing, and fail-closed refusal checks.
  - `jev_decide_batch` — Concurrent worker pool with shared backoff (`429`, `5xx`, transient `402 openrouter_in_flight_budget`), `$ per 1k` accounting, cached token tracking, and confidence histograms (`<0.5`, `0.5-0.8`, `>=0.8`).
  - `jev_list_recipes` — Offline catalog of all 10 official TypeSafe + OpenRouter recipes.
  - `jev_run_recipe` *(eager)* — Execute any of the 10 recipes (`dryRunExample: true` supported for instant smoke tests).
  - `jev_calibrate_auto` — Evaluates labeled datasets (or calibrates `$0` offline via `precomputedAnswer`), runs throwaway-UID self-consistency & Choice option-order permutation audits, fits 1D temperature scaling (ECE/MCE/Brier/NLL before vs after), and optimizes 3-lane SLA/cost bands (`approve` / `review` / `block`).
  - `jev_calibration_profiles` — Manage persistent profiles in `${PLUGIN_DATA}/calibrations/`, run **$0 offline re-tuning** from raw judgments, and enforce pinned-model checks at runtime.
  - `jev_lint_design` — Offline (`$0`) TypeSafe Model Jaggedness + API limits auditor (`<= 32 MiB`, depth `<= 64`, finite numbers, unused asset keys, image formats, counting/math/date traps, inverted Nouls, bare numeric Scores, missing Box Companion Nouls, prompt-injection defense).
  - `jev_models_and_router` — Live `/api/v1/models?output_modalities=decisions`, `/api/v1/key` spend limits, persisted plugin settings (`config.json`), and `typesafe/jev-router` `/api/v1/responses` dispatch with `X-OpenRouter-Metadata`.
- **3 MCP Resources**: `jev://docs/typesafe-rules`, `jev://docs/openrouter-rules`, `jev://calibrations`
- **3 MCP Prompts**: `jev-audit-codebase`, `jev-calibrate-workflow`, `jev-design-decision`
- **3 Skills**: `/typesafe-jev` (+ deep references), `/jev-calibrate`, `/jev-recipes`
- **Rules**: Always-on [rules/AGENTS.md](rules/AGENTS.md) and glob-scoped [rules/typesafe-jev.md](rules/typesafe-jev.md)
- **Custom Subagent / Agent**: `jev-architect` ([agents/jev-architect.md](agents/jev-architect.md))

---

## Development & Verification

```bash
npm install
npm run build      # Bundles standalone dist/mcp-server.mjs (0755)
npm run typecheck  # Strict TypeScript check
npm run validate   # Strict Antigravity plugin validator
npm test           # Unit, HTTP mock client/recipes, calibration, and zero-node_modules stdio MCP suite
```

### Configuration & Environment Variables
Optional overrides can be saved cleanly via `jev_models_and_router(action="update_config", ...)` to `${PLUGIN_DATA}/config.json` or supplied via env:
- `OPENROUTER_API_KEY` (required for live OpenRouter calls)
- `JEV_DEFAULT_MODEL` (default: `typesafe/jev-1.14`)
- `OPENROUTER_ZDR=true` (strict Zero Data Retention routing)
- `OPENROUTER_PREFERRED_MAX_LATENCY_P90` (preferred p90 latency cap in seconds)
- `JEV_CACHE_ENABLED=true`, `JEV_CACHE_TTL` (OpenRouter response caching headers)
- `OPENROUTER_APP_VISIBILITY=hidden` (`X-OpenRouter-App-Visibility: hidden`)
- `OPENROUTER_HTTP_REFERER`, `OPENROUTER_APP_TITLE`, `OPENROUTER_APP_CATEGORIES`
