---
trigger: glob
globs: "**/*.ts, **/*.tsx, **/*.js, **/*.mjs, **/*.py"
description: Coding guardrails when integrating TypeSafe Jev or the OpenRouter Decisions / System One APIs in TypeScript, JavaScript, or Python.
---

When writing or reviewing code that calls `https://openrouter.ai/api/alpha/decisions`, `https://openrouter.ai/api/v1/systemone`, or the `jev` MCP tools:

- **Schema & Limits**: Validate UTF-8 body `<= 32 MiB`, JSON depth `<= 64`, finite numbers only (serialize big integers/decimals as strings), and ensure every key in top-level `assets` is referenced inside `state`, `instructions`, or `criteria`.
- **No Duplicate Media Payloads**: Do not put the same image in both `assets` and inline `image_url` inside `state`; each occurrence counts separately toward limits and tokens. Use still baseline PNG or JPEG (`256-1568px` per side, EXIF upright, `<= 16 MiB` decoded).
- **Explicit Refusal & Error Guards**: Check `answer.type === "refusal"` (and handle HTTP `400`/`401`/`402`/`403`/`429`/`5xx`) explicitly in application code so safety gates fail closed (`block` or `human_review`), never defaulting to `true`/`allow`.
- **Calibrated Thresholds Over Hardcoded Guesses**: Use saved `jev_calibrate_auto` profiles (`approveAt`, `blockAt`, `confidenceMin`, `temperature`) and pin `typesafe/jev-1.14` in production requests. Check `score` runner-up/bimodal conditions before acting automatically.
- **Deterministic Pre-Checks First**: Place regex/schema/denylist checks in local code before making a network call to Jev.
