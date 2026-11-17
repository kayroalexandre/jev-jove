# OpenRouter Decisions API, Jev Router & Operational Best Practices

Reference distilled from official `openrouter.ai/docs` (`/guides/features/decisions`, `/guides/community/jev`, `/guides/community/multimodal-decisions`, `/guides/routing/routers/jev-router`, `/app-attribution`, `/api_reference/limits`, `/guides/best-practices/*`).

## 1. API Surfaces & Discovery
- **`POST /api/alpha/decisions`**: Canonical cross-model OpenRouter Decisions API (`model`, `state`, `questions`, optional `assets`, `provider`, `session_id`, `user`).
- **`POST /api/v1/systemone`**: First-party TypeSafe SDK compatibility endpoint (`baseURL = https://openrouter.ai/api/v1`).
- **`POST /api/v1/responses` (`typesafe/jev-router`)**: Intelligent routing using Jev to select candidate model + `reasoning.effort` for generative requests.
  - Supports plugin parameters: `{ id: "jev-router", cost_tier: "low" | "medium" | "high", models?: [...], allowed_models?: [...], excluded_models?: [...] }`.
  - Note: `models` / `allowed_models` are include preferences with catalog-validated fallback; `excluded_models` are **hard exclusions**. Send header `X-OpenRouter-Metadata: enabled` to inspect `openrouter_metadata.pipeline`.
- **Model Discovery (`GET /api/v1/models?output_modalities=decisions`)**: Query live Decisions models; combine with `&input_modalities=image` or `&zdr=true`.

## 2. Multimodal Rules Across OpenRouter Adapters
- For `typesafe/jev-1.14`, inline `image_url` (`data:image/png;base64,...` or `data:image/jpeg;base64,...`) AND `assets` references work across `state`, `instructions`, and `criteria`.
- **Never duplicate** the same image in both `assets` and inline `state`: every reference or inline part counts separately against payload/token limits.
- Non-TypeSafe Decisions models (e.g. `cloudflare/clef-flash`, `inception/mercury-decide`, `liquid/d1`) reject nested `image_url` parts outside top-level `state[]` with HTTP 400.

## 3. Recommended Production Headers & Provider Routing
- **App Attribution**:
  - `HTTP-Referer`: app/repo URL
  - `X-OpenRouter-Title` (+ `X-Title`): readable app name
  - `X-OpenRouter-Categories`: comma-separated OpenRouter category tags (e.g. `cli-agent,programming-app`)
  - `X-OpenRouter-App-Visibility: hidden` (when private/internal workspace apps shouldn't surface publicly)
- **ZDR & Privacy**: Set `provider: { zdr: true }` to restrict execution strictly to Zero Data Retention endpoints.
- **Latency & Cost Routing**:
  - Use `provider.preferred_max_latency: { p90: seconds }` (e.g. `0.8`s) or `provider.sort: { by: "price", partition: "none" }` with `preferred_min_throughput`.
  - Pass `session_id` consistently per conversation/pipeline for sticky prompt-cache affinity and Broadcast trace grouping.
- **Response Caching**: Opt-in via `X-OpenRouter-Cache: true` and `X-OpenRouter-Cache-TTL: <seconds>` (use `false` or cache clear during calibration/self-consistency runs!).
- **TypeSafe Danger-Zone Headers**:
  - `TypeSafe-Danger-Zone-Long-Context: true`
  - `TypeSafe-Danger-Zone-Images: true` (auto-attached by this plugin on `box` or `assets`).

## 4. Rate Limits, Spend Budgets & Error Semantics (`api_reference/limits`)
- **Pre-Flight Balance Check**: Query `GET /api/v1/key` to read `limit`, `limit_remaining`, `usage`, and `effective_budget` before expensive batch evaluations.
- **Retry Policy**:
  - **Retry with exponential backoff + jitter (honoring `Retry-After`)**:
    - `429` (Rate limit)
    - `5xx` (`500`, `502`, `503`, `529`)
    - **`402` ONLY when `error.metadata.limit_source === "openrouter_in_flight_budget"`** (transient concurrent reservation contention — resolves once in-flight requests settle).
  - **Fail Fast (NEVER retry)**:
    - `400` / `413` / `415` / `422` (validation, image bounds, payload too large, unused asset key)
    - `401` (missing/revoked API key)
    - `402` (`openrouter_credits`, `openrouter_key_limit`, `openrouter_org_limit`)
    - `403` (budget cap exceeded; inspect `error.metadata.resets_at`)
- **Refusal Policy**: Fail closed whenever any answer has `type === "refusal"` or a requested key is missing from `answers`.
