---
name: jev-recipes
description: >-
  Select, inspect, test, and run all 10 official TypeSafe and OpenRouter Jev recipes (support triage, tool-call gate, auto-approve permission prompts, verified LLM cascade, batch classify/tag, RAG passage filter, candidate/date extraction, image Box + Noul localization, composite rubric score, and Jev Router). Use when the user asks for an out-of-the-box Jev recipe or cookbook pattern.
---

# Official TypeSafe & OpenRouter Recipes Workflow

All 10 official cookbook patterns are built into the `jev` MCP server with validated schemas, fail-closed safety guards, and runnable example payloads.

## Execution Steps

1. **Discover Available Recipes (`jev_list_recipes`)**
   - Call `jev_list_recipes` (100% offline) to inspect exact input payloads, primitive combinations, and official doc references.

2. **Quick Smoke Test (`dryRunExample: true`)**
   - Call `jev_run_recipe` with `recipeId` and `dryRunExample: true` (plus optional overrides in `payload`) to verify end-to-end behavior immediately with your OpenRouter key.

3. **Available Recipe Catalog**
   - `support-triage` — Parallel `noul` (churn) + `choice` (department + secondary CC `>0.25`) + `score` (4-level urgency).
   - `gate-tool-call` — Deterministic pre-checks + 3-lane `approve` (`>=0.9`) / `review` / `block` (`<=0.1`) Noul with anti-injection prompt & fail-closed refusals.
   - `auto-approve-permission` — Coding-agent shell risk regex filter + `is_reversible` & `matches_user_task` Nouls -> `allow` / `ask`.
   - `jev-verified-cascade` — Cheap draft model + Jev grounding Choice (`supported` / `unsupported` / `declined`, `0.8` confidence bar) -> escalates to frontier model only on failed verification.
   - `batch-classify-tag` — Scalable concurrent worker pool with 1 Choice category + N parallel Noul tags + exact `$ per 1k` telemetry.
   - `rag-passage-filter` — Filters distractor RAG chunks using paired Nouls to prevent context rot before downstream LLM generation.
   - `grounded-extract-select` — Choice + Companion Noul over extracted regex candidates OR enumerated Year/Month/Day Choice date parts assembled strictly in JS code.
   - `image-box-inspect` — `typesafe/jev-1.14` Box localization + mandatory Companion Existence Noul + optional confidence margin padding (`padBox`).
   - `composite-score` — Parallel descriptive Score rubrics normalized & weighted in JS code + bimodal/low-confidence escalation.
   - `jev-router-chat` — Dispatches `/api/v1/responses` through `typesafe/jev-router` with `costTier`, `reasoningEffort`, include/exclude model filters, and `X-OpenRouter-Metadata` telemetry.
