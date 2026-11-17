---
name: typesafe-jev
description: >-
  Build, audit, lint, and optimize TypeSafe Jev (System One) decisions on OpenRouter using Noul, Choice, Score, and Box primitives. Use when replacing prompt-and-parse LLM calls, designing structured classification or gating pipelines, or debugging TypeSafe Model Jaggedness and OpenRouter API errors.
---

# TypeSafe Jev on OpenRouter — Engineering Playbook

TypeSafe Jev (`typesafe/jev-1.14`) is a **System One** structured decision model on OpenRouter (`POST /api/alpha/decisions` and `POST /api/v1/systemone`). Instead of generating prose, Jev evaluates a `state` and one or more typed `questions` in parallel, returning typed answers with calibrated probabilities (`$0.042 / 1M` input tokens, `$0 / output token`).

## Core Design Workflow

1. **Choose the Right Mechanism**
   - Binary/multi-class/ordered/box judgments -> **`jev_decide`** (or Decisions API)
   - Arbitrary field extraction (invoice ID, phone) -> **OpenRouter Extractions API** (`/api/alpha/extractions`) or **`grounded-extract-select`**
   - Open-ended prose / reasoning / code synthesis -> **Chat/Responses LLM** (or **`typesafe/jev-router`** via `jev_models_and_router`)

2. **Decompose Cleanly into Primitives**
   - **`noul`**: Yes/No condition (`noul = P(yes)`, confidence `|2p - 1|`). Keep atomic and positively phrased (`true = present`).
   - **`choice`**: 2–255 mutually exclusive options (`confidence = (p_max - 1/N)/(1 - 1/N)`). Add a **Companion Noul** when `"none apply"` might occur instead of a vague `other` catch-all; use `{ what, not_for, examples }` for close labels. Check runner-ups `> 0.25`.
   - **`score`**: 2–10 ordered levels with **concrete descriptive text** (never bare numbers). Compute weighted composites in code, never in Jev. Escalate on bimodal splits or low confidence.
   - **`box`**: Requires `typesafe/jev-1.14` (`jev-1.13` returns HTTP 400). Normalized `[0, 1]` edges `(top, bottom, left, right)`. **Always** pair with a Companion Noul verifying object existence in the same request.

3. **Lint Before Calling (`jev_lint_design`)**
   - Run `jev_lint_design` offline (`$0`) on any new schema to catch TypeSafe's 9 Model Jaggedness traps (counting, math, date math, degree Nouls, inverted Nouls, compound Nouls, large state context rot, bare numeric Score levels, missing Box companion Noul, unreferenced assets, duplicate image parts, missing prompt-injection guard, unpinned aliases on calibrated pipelines) and payload limits (`<= 32 MiB`, depth `<= 64`, finite numbers, PNG/JPEG `256-1568px` upright).

4. **Parallel Fan-Out & Fail-Closed Production Guards**
   - Bundle independent Noul/Choice/Score questions for one `state` into ONE `jev_decide` call.
   - Run deterministic regex/schema pre-checks locally before network calls.
   - Always check `answer.type === "refusal"` and handle HTTP errors (`400`/`401`/`402`/`403`/`429`/`5xx`) fail-closed (`block` or `human_review`).

## On-Demand Deep References
- Read `references/typesafe-patterns-and-jaggedness.md` for confidence math, all 9 failure modes, Companion Noul patterns, context limits, and image specs.
- Read `references/openrouter-best-practices.md` for Decisions vs SystemOne adapters, ZDR, App Attribution headers, caching, latency/spend routing, `/api/v1/key` limits, and error codes (`402` transient vs permanent).
- Read `references/recipes-catalog.md` for all 10 official TypeSafe and OpenRouter recipes.
