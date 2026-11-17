# Official TypeSafe & OpenRouter Recipes Catalog

All 10 recipes below are built into `jev_list_recipes` and executable directly via `jev_run_recipe`.

| Recipe ID | Pattern | Primitives & Code Logic | Default Key Cutoffs |
| :--- | :--- | :--- | :--- |
| `support-triage` | Customer Support Triage | `noul` (churn) + `choice` (team + runner-up CC) + 4-level `score` (urgency) | Noul `0.7`/`0.3`; Runner-up CC `> 0.25`; Score bimodal escalation |
| `gate-tool-call` | Agent Tool-Call Safety Gate | Deterministic pre-checks + guarded Noul `is_supported_and_safe` | `approveAt = 0.9`, `blockAt = 0.1`, middle -> `review`; fail closed on error/refusal |
| `auto-approve-permission` | Coding Agent Permission Auto-Approve | Shell risk regex denylist + parallel `is_reversible` & `matches_user_task` Nouls | Both `>= 0.85` -> `allow`, else `ask` |
| `jev-verified-cascade` | Draft -> Jev Verify -> Frontier Escalate | Optional cheap draft -> Jev `choice` (`supported`/`declined`/`unsupported`) -> strong LLM only on failure | `acceptConfidence = 0.8` |
| `batch-classify-tag` | Scalable Batch Categorization & Tagging | Shared-backoff concurrent worker pool with 1 Choice category + N Noul tags | `tagThreshold = 0.7`; reports `$ per 1k` & cached tokens |
| `rag-passage-filter` | RAG Distractor Filter | Paired Nouls (`directly_answers`, `relevant_context`) in concurrent batch | `minRelevanceProb = 0.55`; sorts kept chunks descending |
| `grounded-extract-select` | Extraction Selection / Date Assembly | Regex/list candidates -> Choice + Companion Noul; OR Year/Month/Day Choices | `confidenceMin = 0.7`; calendar validity + date math in JS |
| `image-box-inspect` | Visual Box Localization | `box` + mandatory Companion `noul` (`target_present`) on `typesafe/jev-1.14` | `presenceThreshold = 0.7`; optional confidence margin padding |
| `composite-score` | Weighted Multi-Rubric Quality Score | Multiple descriptive 2–10 level `score` criteria normalized & weighted in JS | Flags bimodal splits or `confidence < 0.6` |
| `jev-router-chat` | Jev Router LLM Dispatch | `typesafe/jev-router` on `/api/v1/responses` with `X-OpenRouter-Metadata: enabled` | `cost_tier`: `low` / `medium` / `high` + include/exclude lists |
