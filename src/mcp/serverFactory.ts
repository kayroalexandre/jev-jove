import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { auditConsistency } from "../calibration/consistency.js";
import {
  applyCalibratedProfileToAnswer,
  buildCalibrationProfileFromJudgments,
  deleteCalibrationProfile,
  listCalibrationProfiles,
  loadCalibrationProfile,
  retuneProfileOffline,
  saveCalibrationProfile,
  type StoredJudgmentSample,
} from "../calibration/store.js";
import {
  loadRuntimeConfig,
  resolveOpenRouterApiKey,
  saveRuntimeConfigPatch,
} from "../config/runtimeConfig.js";
import {
  DecisionRefusalError,
  OpenRouterApiError,
  OpenRouterJevClient,
} from "../openrouter/client.js";
import { executeRecipe, RECIPES, type RecipeId } from "../recipes/index.js";
import {
  AssetEntrySchema,
  DecisionAnswerSchema,
  DecisionQuestionSchema,
  PINNED_JEV_MODEL,
  PluginRuntimeConfigPatchSchema,
  ProviderRoutingSchema,
  type ChoiceAnswer,
  type NoulAnswer,
  type ScoreAnswer,
} from "../types/decisions.js";
import {
  analyzeChoiceRunnerUp,
  computeScoreStats,
  extractConfidence,
  interpretNoulBand,
  normalizeScoreValue,
} from "../typesafe/confidence.js";
import { lintDesign } from "../typesafe/linter.js";

const TYPESAFE_BEST_PRACTICES_MD = `# TypeSafe Jev (System One) Official Engineering Guide

## 1. Core Primitives & Pricing
- **Model**: Pin \`${PINNED_JEV_MODEL}\` for production / calibrated systems; \`~typesafe/jev-latest\` floats across releases.
- **Pricing**: \`$0.042 / 1M input tokens\`, \`$0 / output token\` on OpenRouter. All \`usage.cost\` values report exact billed USD.
- **Context & Transport**:
  - Default mode: 64k tokens per request / 32k tokens per question (recommended for speed & accuracy).
  - Long-context mode: \`262,144\` tokens via header \`TypeSafe-Danger-Zone-Long-Context: true\`.
  - Max request body: 32 MiB UTF-8 (no BOM), JSON nesting depth <= 64, finite numbers only (large decimals/IDs as strings).
- **Primitives**:
  - \`noul\`: \`P(yes)\` in \`[0, 1]\`. Confidence = \`|2p - 1|\`. Band defaults: \`>= 0.7\` yes, \`<= 0.3\` no, \`(0.3, 0.7)\` uncertain. High-stakes gating: \`>= 0.9\` approve, \`<= 0.1\` block.
  - \`choice\`: Single pick among 2-255 mutually exclusive options. Confidence = \`(p_max - 1/N) / (1 - 1/N)\`. Use Companion Noul instead of catch-all \`other\` when unsure if any label fits. Check runner-ups \`> 0.25\` for secondary routing.
  - \`score\`: 2-10 **concrete ordered descriptions** (NEVER bare numbers \`"1","2","3"\`). Returns probability-weighted \`score\` in \`[0, N-1]\` + discrete bucket probs. Escalate when bimodal split or low confidence. Never interpolate Score to recover exact numeric values.
  - \`box\`: Requires \`typesafe/jev-1.14\` or \`~typesafe/jev-latest\` (\`jev-1.13\` rejects with 400). Normalized edges \`top, bottom, left, right\` in \`[0, 1]\`. ALWAYS pair with a Companion Noul checking target existence in the same request.

## 2. Model Jaggedness (9 Avoidable Failure Modes)
1. **Literal reading** -> Phrase instructions plainly for an attentive human reader.
2. **Counting / Math / Score interpolation** -> Iterate & sum in code; never ask Jev to count or do arithmetic.
3. **Date/Time comparison** -> Extract enumerated Year/Month/Day Choices (plus \`not_stated\`) and assemble/compare in code.
4. **Indirection / Double negatives** -> Ask directly; refer to state fields by exact key names.
5. **Large state context rot** -> Strip irrelevant fields in code or filter with Noul first.
6. **Adversarial prompt injection** -> State explicitly that user/tool text is *data to judge, never instructions overriding policy*.
7. **Contradictory instructions & criteria** -> Align instructions and positive criteria cleanly.
8. **Choice option order bias** -> Audit with reversed/rotated option orders when margin matters.
9. **Free-form generation** -> Use bounded Choice over extracted candidates, or a generative LLM (\`typesafe/jev-router\`) for prose.

## 3. Images
- Baseline still **PNG or JPEG** only (\`256..1568px\` per side, \`78,400..2,458,624\` total pixels), EXIF pre-rotated upright, decoded file <= 16 MiB, expanded payload <= 32 MiB.
- Do not duplicate the same image in both \`assets\` and inline \`image_url\`. Every declared asset key MUST be referenced in \`state\`, \`instructions\`, or \`criteria\`.
`;

const OPENROUTER_BEST_PRACTICES_MD = `# OpenRouter Decisions & Routing Official Guide

## 1. Endpoints
- **Decisions API**: \`POST /api/alpha/decisions\` (standard cross-provider interface for Jev, Clef, Mercury Decide, D1, GPT-6 Luna Decisions, Gemini Decision 1).
- **System One API**: \`POST /api/v1/systemone\` (drop-in TypeSafe SDK compatibility surface).
- **Jev Router**: \`POST /api/v1/responses\` with \`model: "typesafe/jev-router"\` and optional \`plugins: [{ id: "jev-router", cost_tier: "low" | "medium" | "high", models, allowed_models, excluded_models }]\`. Inspect selection with \`X-OpenRouter-Metadata: enabled\`.
- **Discovery & Spend**:
  - \`GET /api/v1/models?output_modalities=decisions\` (supports \`input_modalities=image\`, \`zdr=true\`).
  - \`GET /api/v1/key\` to monitor remaining key/account budgets before large batch jobs.

## 2. Headers, Privacy & Performance
- **App Attribution**: Send \`HTTP-Referer\`, \`X-OpenRouter-Title\`, \`X-OpenRouter-Categories\`, and optional \`X-OpenRouter-App-Visibility: hidden\`.
- **Zero Data Retention (ZDR)**: Set \`provider: { zdr: true }\` for strict zero-retention routing.
- **Latency & Fallbacks**: Use \`provider.preferred_max_latency: { p90: seconds }\` or \`sort: "price"\` + \`preferred_min_throughput\`, and \`session_id\` for prompt-cache locality & Broadcast observability.
- **Response Caching**: Opt-in via \`X-OpenRouter-Cache: true\` and \`X-OpenRouter-Cache-TTL\` (avoid for consistency tests!).

## 3. Error Handling & Fail-Closed Production Rules
- **Fail-Closed Refusals**: Always inspect \`answer.type\`. Treat \`"refusal"\`, missing answer keys, or HTTP errors on safety/approval gates as **block / escalate**, never as pass/safe.
- **Retries**:
  - Retry with exponential backoff + jitter (honoring \`Retry-After\` header) on \`429\`, \`5xx\`, and **transient \`402\` when \`error.metadata.limit_source === "openrouter_in_flight_budget"\`**.
  - Fail fast on \`400\`, \`401\`, \`403\` (budget exhausted / \`resets_at\`), and permanent \`402\` (\`openrouter_credits\`, \`openrouter_key_limit\`).
`;

function formatToolError(err: unknown) {
  if (err instanceof OpenRouterApiError) {
    return {
      isError: true as const,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              error: err.message,
              type: "OpenRouterApiError",
              status: err.status,
              retryable: err.retryable,
              limitSource: err.limitSource,
              remedyHint: err.remedyHint,
              resetsAt: err.resetsAt,
            },
            null,
            2,
          ),
        },
      ],
    };
  }
  if (err instanceof DecisionRefusalError) {
    return {
      isError: true as const,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              error: err.message,
              type: "DecisionRefusalError",
              failClosed: true,
              refusals: err.refusals,
              model: err.response.model,
            },
            null,
            2,
          ),
        },
      ],
    };
  }
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            error: err instanceof Error ? err.message : String(err),
            type: err instanceof Error ? err.name : "Error",
          },
          null,
          2,
        ),
      },
    ],
  };
}

function summarizeAnswerEnrichments(answers: Record<string, z.infer<typeof DecisionAnswerSchema>>) {
  const enriched: Record<string, unknown> = {};
  for (const [qId, ans] of Object.entries(answers)) {
    if (ans.type === "noul") {
      enriched[qId] = {
        ...ans,
        computedConfidence: extractConfidence(ans),
        interpretation: interpretNoulBand(ans),
      };
    } else if (ans.type === "choice") {
      const analysis = analyzeChoiceRunnerUp(ans);
      enriched[qId] = {
        ...ans,
        computedConfidence: analysis.confidence,
        secondaryOptionsAbove25Pct: analysis.secondaryOptions,
      };
    } else if (ans.type === "score") {
      const stats = computeScoreStats(ans.probabilities);
      enriched[qId] = {
        ...ans,
        computedConfidence: extractConfidence(ans),
        normalizedScore: Number(normalizeScoreValue(ans).toFixed(4)),
        stdDev: Number(stats.stdDev.toFixed(4)),
        isBimodal: stats.isBimodal,
        topTwoLevels: stats.topTwoLevels,
      };
    } else {
      enriched[qId] = {
        ...ans,
        computedConfidence: extractConfidence(ans),
      };
    }
  }
  return enriched;
}

export function createJevMcpServer(deps?: {
  client?: OpenRouterJevClient;
}): McpServer {
  const client = deps?.client ?? new OpenRouterJevClient();

  const server = new McpServer(
    {
      name: "jev-openrouter",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions: [
        "TypeSafe Jev (System One) Decisions MCP server backed by OpenRouter.",
        `Default model is pinned '${PINNED_JEV_MODEL}'. Output tokens are free; input tokens bill at $0.042/M on Jev 1.14.`,
        "Always bundle related Noul/Choice/Score questions over one shared state into a single jev_decide call rather than sequential calls.",
        "Before production deployment, audit question structures with jev_lint_design and calibrate thresholds/temperature with jev_calibrate_auto.",
        "Never ask Jev to count, do arithmetic, compare raw dates, or generate prose: extract bounded parts or candidates with Jev and compute in code.",
        "Fail closed on any DecisionRefusalError, missing answer key, or API error on sensitive gates.",
      ].join(" "),
    },
  );

  // 1. jev_decide
  server.registerTool(
    "jev_decide",
    {
      title: "Execute TypeSafe Jev Decisions",
      description:
        "Evaluate structured state against 1 or more typed System One questions (noul, choice, score, box) in one parallel OpenRouter request. Includes automatic pre-flight design linting, optional calibrated profile application, confidence/runner-up/bimodal enrichment, ZDR/latency routing, caching, and fail-closed refusal checks.",
      inputSchema: {
        model: z
          .string()
          .optional()
          .describe(`Model ID (default '${PINNED_JEV_MODEL}'; use 'typesafe/jev-1.14' for Box & calibrated systems).`),
        state: z.unknown().describe("String, JSON object, or multimodal array representing the situation to judge."),
        questions: z
          .record(z.string(), DecisionQuestionSchema)
          .refine((obj) => Object.keys(obj).length > 0, "At least 1 question is required.")
          .describe("Map of questionId -> { type: 'noul'|'choice'|'score'|'box', instructions, criteria }."),
        assets: z
          .record(z.string(), AssetEntrySchema)
          .optional()
          .describe("Optional top-level image asset map referenced inside state/questions."),
        endpointMode: z
          .enum(["decisions", "systemone"])
          .optional()
          .describe("OpenRouter surface: 'decisions' (/api/alpha/decisions, default) or 'systemone' (/api/v1/systemone)."),
        provider: ProviderRoutingSchema.optional().describe("OpenRouter provider routing controls (zdr, preferred_max_latency, order, only, ignore)."),
        sessionId: z.string().optional().describe("Sticky session_id for cache affinity and OpenRouter observability."),
        user: z.string().optional().describe("End-user identifier for analytics/rate-limit attribution."),
        longContext: z.boolean().optional().describe("Send TypeSafe-Danger-Zone-Long-Context: true (unlocks 262k context)."),
        imagesOptIn: z.boolean().optional().describe("Send TypeSafe-Danger-Zone-Images: true (auto-enabled for assets/box)."),
        responseCache: z.boolean().optional().describe("Explicitly enable or bypass OpenRouter response cache."),
        cacheTtlSeconds: z.number().int().min(1).max(86400).optional(),
        cacheClear: z.boolean().optional(),
        failOnRefusal: z.boolean().optional().describe("Fail closed (default true) if any question returns type='refusal'."),
        runLint: z.boolean().optional().describe("Pre-flight lint request against TypeSafe jaggedness/API limits (default true)."),
        calibrationProfileId: z
          .string()
          .optional()
          .describe("Optional saved calibration profile ID to apply temperature scaling & routing band."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const cfg = loadRuntimeConfig();
        const modelToUse = args.model?.trim() || cfg.defaultModel;

        const lintReport =
          args.runLint === false
            ? undefined
            : lintDesign({
                model: modelToUse,
                state: args.state,
                questions: args.questions,
                assets: args.assets,
                longContext: args.longContext,
                imagesOptIn: args.imagesOptIn,
                calibrated: Boolean(args.calibrationProfileId),
              });

        if (lintReport && lintReport.status === "fail") {
          const errors = lintReport.diagnostics.filter((d) => d.severity === "error");
          throw new Error(
            `Pre-flight TypeSafe linter blocked request (${errors.length} error(s)): ${errors
              .map((e) => `[${e.code}] ${e.message}`)
              .join("; ")}`,
          );
        }

        const exec = await client.decide({
          model: modelToUse,
          state: args.state,
          questions: args.questions,
          assets: args.assets,
          endpointMode: args.endpointMode,
          provider: args.provider,
          sessionId: args.sessionId,
          user: args.user,
          longContext: args.longContext,
          imagesOptIn: args.imagesOptIn,
          responseCache: args.responseCache,
          cacheTtlSeconds: args.cacheTtlSeconds,
          cacheClear: args.cacheClear,
          failOnRefusal: args.failOnRefusal,
        });

        let calibratedApplication: unknown;
        if (args.calibrationProfileId) {
          const profile = loadCalibrationProfile(args.calibrationProfileId);
          const rawTarget = exec.response.answers[profile.questionId];
          if (rawTarget) {
            calibratedApplication = applyCalibratedProfileToAnswer(
              profile,
              rawTarget,
              exec.response.model,
            );
          } else {
            calibratedApplication = {
              warning: `Profile '${profile.profileId}' targets questionId '${profile.questionId}', which was absent in this request.`,
            };
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  id: exec.response.id,
                  model: exec.response.model,
                  provider: exec.response.provider,
                  endpointUsed: exec.endpointUsed,
                  latencyMs: exec.latencyMs,
                  attempts: exec.attempts,
                  estimatedCostUsd: exec.estimatedCostUsd,
                  cachedTokens: exec.cachedTokens,
                  usage: exec.response.usage,
                  answers: summarizeAnswerEnrichments(exec.response.answers),
                  calibratedResult: calibratedApplication,
                  refusals: exec.refusals,
                  lint: lintReport,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 2. jev_decide_batch
  server.registerTool(
    "jev_decide_batch",
    {
      title: "Batch TypeSafe Jev Decisions",
      description:
        "Run typed Decisions across a batch of items using a bounded worker pool with shared 429/transient-402/5xx backoff. Reports exact cost per 1,000 items, cached token savings, confidence band histogram (<0.5, 0.5-0.8, >=0.8), and optional calibration profile routing.",
      inputSchema: {
        items: z
          .array(
            z.object({
              id: z.string(),
              state: z.unknown(),
              questions: z.record(z.string(), DecisionQuestionSchema).optional(),
              assets: z.record(z.string(), AssetEntrySchema).optional(),
            }),
          )
          .min(1),
        sharedQuestions: z.record(z.string(), DecisionQuestionSchema).optional(),
        model: z.string().optional(),
        concurrency: z.number().int().min(1).max(32).optional(),
        provider: ProviderRoutingSchema.optional(),
        sessionId: z.string().optional(),
        user: z.string().optional(),
        responseCache: z.boolean().optional(),
        longContext: z.boolean().optional(),
        failOnRefusal: z.boolean().optional(),
        calibrationProfileId: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const profile = args.calibrationProfileId
          ? loadCalibrationProfile(args.calibrationProfileId)
          : undefined;

        const batch = await client.runBatch({
          items: args.items,
          sharedQuestions: args.sharedQuestions,
          model: args.model,
          concurrency: args.concurrency,
          provider: args.provider,
          sessionId: args.sessionId,
          user: args.user,
          responseCache: args.responseCache,
          longContext: args.longContext,
          failOnRefusal: args.failOnRefusal,
        });

        // Confidence histogram across all answered questions
        let low = 0;
        let moderate = 0;
        let high = 0;
        const formattedResults = batch.results.map((r) => {
          if (!r.ok) return r;
          for (const c of Object.values(r.execution.confidences)) {
            if (c < 0.5) low++;
            else if (c < 0.8) moderate++;
            else high++;
          }
          const calibrated =
            profile && r.execution.response.answers[profile.questionId]
              ? applyCalibratedProfileToAnswer(
                  profile,
                  r.execution.response.answers[profile.questionId]!,
                  r.execution.response.model,
                )
              : undefined;
          return {
            id: r.id,
            ok: true,
            model: r.execution.response.model,
            latencyMs: r.execution.latencyMs,
            costUsd: r.execution.estimatedCostUsd,
            answers: r.execution.response.answers,
            confidences: r.execution.confidences,
            calibrated,
          };
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  model: batch.model,
                  concurrency: batch.concurrency,
                  totalItems: batch.totalItems,
                  succeededCount: batch.succeededCount,
                  failedCount: batch.failedCount,
                  refusalCount: batch.refusalCount,
                  totalCostUsd: batch.totalCostUsd,
                  costPer1kItemsUsd: Number(batch.costPer1kItemsUsd.toFixed(6)),
                  totalInputTokens: batch.totalInputTokens,
                  totalCachedTokens: batch.totalCachedTokens,
                  durationMs: batch.durationMs,
                  confidenceHistogram: {
                    below0_5: low,
                    band0_5to0_8: moderate,
                    atOrAbove0_8: high,
                  },
                  results: formattedResults,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 3. jev_list_recipes (offline!)
  server.registerTool(
    "jev_list_recipes",
    {
      title: "List Official TypeSafe & OpenRouter Recipes",
      description:
        "Return the complete catalog of 10 official TypeSafe + OpenRouter Jev recipes with doc URLs, primitive combinations, recommended models, and runnable example payloads (100% offline, no API key needed).",
      inputSchema: {
        recipeId: z.string().optional().describe("Optional recipeId to view full details for one recipe."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        const list = args.recipeId
          ? RECIPES.filter((r) => r.id === args.recipeId)
          : RECIPES;
        if (args.recipeId && list.length === 0) {
          throw new Error(
            `Unknown recipeId '${args.recipeId}'. Available recipes: ${RECIPES.map((r) => r.id).join(", ")}`,
          );
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ count: list.length, recipes: list }, null, 2),
            },
          ],
        };
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 4. jev_run_recipe (eager)
  server.registerTool(
    "jev_run_recipe",
    {
      title: "Run Official TypeSafe or OpenRouter Recipe",
      description:
        "Execute one of the 10 pre-built official recipes: support-triage, gate-tool-call, auto-approve-permission, jev-verified-cascade, batch-classify-tag, rag-passage-filter, grounded-extract-select, image-box-inspect, composite-score, or jev-router-chat. Set dryRunExample=true with empty payload to test with the official sample payload.",
      inputSchema: {
        recipeId: z.enum([
          "support-triage",
          "gate-tool-call",
          "auto-approve-permission",
          "jev-verified-cascade",
          "batch-classify-tag",
          "rag-passage-filter",
          "grounded-extract-select",
          "image-box-inspect",
          "composite-score",
          "jev-router-chat",
        ]),
        payload: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Recipe-specific payload (call jev_list_recipes first to inspect fields, or set dryRunExample=true)."),
        dryRunExample: z
          .boolean()
          .optional()
          .describe("Merge/use the official example payload documented for the recipe."),
        model: z.string().optional(),
        sessionId: z.string().optional(),
        zdr: z.boolean().optional(),
      },
      annotations: {
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const descriptor = RECIPES.find((r) => r.id === args.recipeId);
        const mergedPayload: Record<string, unknown> = args.dryRunExample
          ? { ...(descriptor?.examplePayload ?? {}), ...(args.payload ?? {}) }
          : { ...(args.payload ?? {}) };

        const result = await executeRecipe(client, args.recipeId as RecipeId, mergedPayload, {
          model: args.model,
          sessionId: args.sessionId,
          zdr: args.zdr,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 5. jev_calibrate_auto
  server.registerTool(
    "jev_calibrate_auto",
    {
      title: "Auto-Calibrate TypeSafe Jev Question",
      description:
        "Evaluate labeled examples (or analyze precomputedAnswer datasets 100% offline for $0), run optional self-consistency & Choice option-order permutation audits, fit 1D temperature scaling (ECE/MCE/Brier/NLL before vs after), optimize 3-lane approve/review/block or confidence cutoff thresholds under SLA/cost targets, and persist a reusable calibration profile.",
      inputSchema: {
        profileId: z
          .string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)
          .describe("Unique ID to save calibration profile (e.g. 'tool-gate-v1')."),
        name: z.string().optional(),
        model: z.string().optional().describe(`Pinned model slug (defaults to '${PINNED_JEV_MODEL}').`),
        questionId: z.string().min(1),
        question: DecisionQuestionSchema.refine(
          (q) => q.type !== "box",
          "Use companion Noul + labeled Choice/Score/Noul datasets for calibration; Box coordinates require IoU ground truth.",
        ),
        samples: z
          .array(
            z.object({
              id: z.string(),
              state: z.unknown(),
              label: z
                .union([z.boolean(), z.string(), z.number()])
                .describe("boolean for noul, string option key for choice, numeric target for score."),
              precomputedAnswer: DecisionAnswerSchema.optional().describe(
                "Optional precomputed DecisionAnswer to calibrate 100% offline without spending tokens.",
              ),
            }),
          )
          .min(2),
        fitTemperature: z.boolean().optional().describe("Fit 1D post-hoc temperature scaling via NLL minimization (default true)."),
        minApprovePrecision: z.number().min(0).max(1).optional(),
        minBlockNpv: z.number().min(0).max(1).optional(),
        maxReviewRate: z.number().min(0).max(1).optional(),
        falsePositiveCost: z.number().nonnegative().optional(),
        falseNegativeCost: z.number().nonnegative().optional(),
        reviewCost: z.number().nonnegative().optional(),
        targetAccuracy: z.number().min(0).max(1).optional().describe("Target accuracy for Choice confidence cutoff (default 0.90)."),
        checkConsistency: z.boolean().optional().describe("Run TypeSafe throwaway-UID self-consistency & Choice permutation audit on sample[0]."),
        consistencyRepeats: z.number().int().min(2).max(15).optional(),
        concurrency: z.number().int().min(1).max(32).optional(),
        useCache: z.boolean().optional().describe("Disable cache by default during fresh calibration measurement (default false)."),
      },
      annotations: {
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const cfg = loadRuntimeConfig();
        const pinnedModel = args.model?.trim() || cfg.defaultModel;
        const warnings: string[] = [];
        if (pinnedModel.includes("latest") || pinnedModel.includes("preview")) {
          warnings.push(
            `Model '${pinnedModel}' is a floating alias. Pin '${PINNED_JEV_MODEL}' in production so calibrated thresholds never drift.`,
          );
        }

        const lintReport = lintDesign({
          model: pinnedModel,
          state: args.samples[0]?.state ?? {},
          questions: { [args.questionId]: args.question },
          calibrated: true,
        });

        const allPrecomputed = args.samples.every((s) => s.precomputedAnswer !== undefined);
        const storedJudgments: StoredJudgmentSample[] = [];
        let liveBatchCostUsd = 0;

        if (allPrecomputed) {
          for (const s of args.samples) {
            storedJudgments.push({
              id: s.id,
              state: s.state,
              label: s.label,
              answer: s.precomputedAnswer!,
              costUsd: 0,
            });
          }
        } else {
          const toFetch = args.samples.filter((s) => !s.precomputedAnswer);
          const batch = await client.runBatch({
            model: pinnedModel,
            concurrency: args.concurrency ?? cfg.defaultConcurrency,
            responseCache: args.useCache ?? false,
            failOnRefusal: false,
            items: toFetch.map((s) => ({ id: s.id, state: s.state })),
            sharedQuestions: { [args.questionId]: args.question },
          });
          liveBatchCostUsd = batch.totalCostUsd;

          const byId = new Map(batch.results.map((r) => [r.id, r]));
          for (const s of args.samples) {
            if (s.precomputedAnswer) {
              storedJudgments.push({
                id: s.id,
                state: s.state,
                label: s.label,
                answer: s.precomputedAnswer,
                costUsd: 0,
              });
              continue;
            }
            const r = byId.get(s.id);
            if (!r || !r.ok) {
              throw new Error(`Sample '${s.id}' failed during calibration evaluation: ${r && !r.ok ? r.error : "missing"}`);
            }
            const ans = r.execution.response.answers[args.questionId]!;
            if (ans.type === "refusal") {
              throw new DecisionRefusalError(
                [{ questionId: args.questionId, reason: ans.reason ?? "refusal" }],
                r.execution.response,
              );
            }
            storedJudgments.push({
              id: s.id,
              state: s.state,
              label: s.label,
              answer: ans,
              costUsd: r.execution.estimatedCostUsd,
            });
          }
        }

        let consistencyReport: Record<string, unknown> | undefined;
        if (args.checkConsistency && !allPrecomputed) {
          const cons = await auditConsistency(client, {
            model: pinnedModel,
            state: args.samples[0]!.state,
            questionId: args.questionId,
            question: args.question,
            repeats: args.consistencyRepeats ?? 5,
            bypassCache: true,
            shuffleChoiceOrder: args.question.type === "choice",
          });
          consistencyReport = cons as unknown as Record<string, unknown>;
          liveBatchCostUsd += cons.totalCostUsd;
          if (cons.optionOrderBiasDetected) {
            warnings.push(
              "Choice option-order bias detected across rotated/reversed option orders. Consider structured {what, not_for, examples} criteria.",
            );
          }
        }

        const profile = buildCalibrationProfileFromJudgments({
          profileId: args.profileId,
          name: args.name,
          taskType: args.question.type as "noul" | "choice" | "score",
          questionId: args.questionId,
          question: args.question,
          pinnedModel,
          rawJudgments: storedJudgments,
          fitTemperature: args.fitTemperature,
          routingConfig: {
            minApprovePrecision: args.minApprovePrecision,
            minBlockNpv: args.minBlockNpv,
            maxReviewRate: args.maxReviewRate,
            falsePositiveCost: args.falsePositiveCost,
            falseNegativeCost: args.falseNegativeCost,
            reviewCost: args.reviewCost,
          },
          targetAccuracy: args.targetAccuracy,
          consistencyReport,
        });

        saveCalibrationProfile(profile);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  profileId: profile.profileId,
                  pinnedModel: profile.pinnedModel,
                  taskType: profile.taskType,
                  sampleCount: profile.rawJudgments.length,
                  offlineMode: allPrecomputed,
                  totalCostUsd: Number(liveBatchCostUsd.toFixed(8)),
                  fittedTemperature: profile.temperature,
                  thresholds: profile.thresholds,
                  routingBands: profile.routingBands,
                  summaryBefore: profile.summaryBefore,
                  summaryAfter: profile.summaryAfter,
                  consistencyReport,
                  warnings,
                  lintScore: lintReport.score,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 6. jev_calibration_profiles
  server.registerTool(
    "jev_calibration_profiles",
    {
      title: "Manage & Offline-Retune Calibration Profiles",
      description:
        "List, inspect, delete, offline-retune ($0 API spend from stored raw judgments), or apply a persisted calibration profile (with automatic pinned-model mismatch guard).",
      inputSchema: {
        action: z.enum(["list", "get", "retune", "apply", "delete"]),
        profileId: z.string().optional(),
        fitTemperature: z.boolean().optional(),
        minApprovePrecision: z.number().min(0).max(1).optional(),
        minBlockNpv: z.number().min(0).max(1).optional(),
        maxReviewRate: z.number().min(0).max(1).optional(),
        falsePositiveCost: z.number().nonnegative().optional(),
        falseNegativeCost: z.number().nonnegative().optional(),
        reviewCost: z.number().nonnegative().optional(),
        targetAccuracy: z.number().min(0).max(1).optional(),
        rawAnswer: DecisionAnswerSchema.optional().describe("For action='apply' offline on an existing DecisionAnswer."),
        state: z.unknown().optional().describe("For action='apply' live: calls OpenRouter with profile's pinnedModel & question."),
        responseModel: z.string().optional(),
      },
      annotations: {
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        if (args.action === "list") {
          const profiles = listCalibrationProfiles();
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ count: profiles.length, profiles }, null, 2),
              },
            ],
          };
        }

        if (!args.profileId) {
          throw new Error(`Action '${args.action}' requires profileId.`);
        }

        if (args.action === "get") {
          const profile = loadCalibrationProfile(args.profileId);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(profile, null, 2) }],
          };
        }

        if (args.action === "delete") {
          const deleted = deleteCalibrationProfile(args.profileId);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ profileId: args.profileId, deleted }, null, 2),
              },
            ],
          };
        }

        if (args.action === "retune") {
          const updated = retuneProfileOffline(args.profileId, {
            fitTemperature: args.fitTemperature,
            routingConfig: {
              minApprovePrecision: args.minApprovePrecision,
              minBlockNpv: args.minBlockNpv,
              maxReviewRate: args.maxReviewRate,
              falsePositiveCost: args.falsePositiveCost,
              falseNegativeCost: args.falseNegativeCost,
              reviewCost: args.reviewCost,
            },
            targetAccuracy: args.targetAccuracy,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    profileId: updated.profileId,
                    retunedOfflineUsd: 0,
                    temperature: updated.temperature,
                    thresholds: updated.thresholds,
                    routingBands: updated.routingBands,
                    summaryBefore: updated.summaryBefore,
                    summaryAfter: updated.summaryAfter,
                    updatedAt: updated.updatedAt,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // action === "apply"
        const profile = loadCalibrationProfile(args.profileId);
        if (args.rawAnswer) {
          const applied = applyCalibratedProfileToAnswer(
            profile,
            args.rawAnswer,
            args.responseModel,
          );
          return {
            content: [{ type: "text" as const, text: JSON.stringify(applied, null, 2) }],
          };
        }

        if (args.state === undefined) {
          throw new Error("Action 'apply' requires either rawAnswer (offline) or state (live).");
        }

        const res = await client.decide({
          model: profile.pinnedModel,
          state: args.state,
          questions: { [profile.questionId]: profile.question },
          failOnRefusal: false,
        });
        const ans = res.response.answers[profile.questionId]!;
        const applied = applyCalibratedProfileToAnswer(profile, ans, res.response.model);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ...applied,
                  estimatedCostUsd: res.estimatedCostUsd,
                  latencyMs: res.latencyMs,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 7. jev_lint_design (offline!)
  server.registerTool(
    "jev_lint_design",
    {
      title: "Lint Decision Design Against TypeSafe Rules",
      description:
        "Audit a candidate Jev request offline ($0) for TypeSafe Model Jaggedness (counting, arithmetic, date comparison, degree Noul, negated polarity, compound judgment, context rot, bare numeric Score levels, Box missing companion Noul, unreferenced assets, image format/data URLs, unpinned calibrated alias, prompt injection defense) and hard OpenRouter/TypeSafe payload limits.",
      inputSchema: {
        model: z.string().optional(),
        state: z.unknown(),
        questions: z.record(z.string(), DecisionQuestionSchema),
        assets: z.record(z.string(), AssetEntrySchema).optional(),
        longContext: z.boolean().optional(),
        imagesOptIn: z.boolean().optional(),
        calibrated: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        const report = lintDesign({
          model: args.model,
          state: args.state,
          questions: args.questions,
          assets: args.assets,
          longContext: args.longContext,
          imagesOptIn: args.imagesOptIn,
          calibrated: args.calibrated,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
        };
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 8. jev_models_and_router
  server.registerTool(
    "jev_models_and_router",
    {
      title: "OpenRouter Models, Key Limits, Config & Jev Router",
      description:
        "Inspect live OpenRouter Decisions models (output_modalities=decisions), check API key spend/budget status (/api/v1/key), read/persist plugin settings (defaultModel, ZDR, preferredMaxLatencyP90, caching, App Attribution headers), or dispatch generative prompts through typesafe/jev-router with X-OpenRouter-Metadata diagnostics.",
      inputSchema: {
        action: z.enum(["list_models", "key_status", "get_config", "update_config", "route_chat"]),
        inputModalities: z.array(z.string()).optional(),
        zdrOnly: z.boolean().optional(),
        configPatch: PluginRuntimeConfigPatchSchema.optional(),
        routerRequest: z
          .object({
            model: z.string().optional(),
            input: z.unknown(),
            instructions: z.string().optional(),
            costTier: z.enum(["low", "medium", "high"]).optional(),
            reasoningEffort: z.enum(["minimal", "low", "medium", "high"]).optional(),
            models: z.array(z.string()).optional(),
            allowedModels: z.array(z.string()).optional(),
            excludedModels: z.array(z.string()).optional(),
            maxOutputTokens: z.number().int().positive().optional(),
            sessionId: z.string().optional(),
          })
          .optional(),
      },
    },
    async (args) => {
      try {
        switch (args.action) {
          case "list_models": {
            const models = await client.listDecisionModels({
              inputModalities: args.inputModalities,
              zdrOnly: args.zdrOnly,
            });
            return {
              content: [{ type: "text" as const, text: JSON.stringify(models, null, 2) }],
            };
          }
          case "key_status": {
            const keyInfo = await client.getKeyStatus();
            return {
              content: [{ type: "text" as const, text: JSON.stringify(keyInfo, null, 2) }],
            };
          }
          case "get_config": {
            const cfg = loadRuntimeConfig();
            const hasApiKey = Boolean(resolveOpenRouterApiKey());
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      apiKeyConfigured: hasApiKey,
                      config: cfg,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
          case "update_config": {
            if (!args.configPatch) {
              throw new Error("action='update_config' requires configPatch object.");
            }
            const next = saveRuntimeConfigPatch(args.configPatch);
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      saved: true,
                      apiKeyConfigured: Boolean(resolveOpenRouterApiKey()),
                      config: next,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
          case "route_chat": {
            if (!args.routerRequest) {
              throw new Error("action='route_chat' requires routerRequest object.");
            }
            const out = await client.callJevRouter(args.routerRequest);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }],
            };
          }
        }
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // MCP Resources
  server.registerResource(
    "typesafe-rules",
    "jev://docs/typesafe-rules",
    {
      title: "TypeSafe Jev Engineering & Jaggedness Reference",
      description: "Complete reference of TypeSafe System One primitives, confidence math, limits, and 9 failure modes.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/markdown",
          text: TYPESAFE_BEST_PRACTICES_MD,
        },
      ],
    }),
  );

  server.registerResource(
    "openrouter-rules",
    "jev://docs/openrouter-rules",
    {
      title: "OpenRouter Decisions & Routing Reference",
      description: "OpenRouter Decisions API, System One API, ZDR, latency, caching, budgets, and fail-closed rules.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/markdown",
          text: OPENROUTER_BEST_PRACTICES_MD,
        },
      ],
    }),
  );

  server.registerResource(
    "calibrations-index",
    "jev://calibrations",
    {
      title: "Saved Jev Calibration Profiles",
      description: "Live JSON list of persisted calibration profiles stored under PLUGIN_DATA.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/json",
          text: JSON.stringify({ profiles: listCalibrationProfiles() }, null, 2),
        },
      ],
    }),
  );

  // MCP Prompts
  server.registerPrompt(
    "jev-audit-codebase",
    {
      title: "Audit Codebase for Jev Decisions",
      description: "Inspect repository code for fragile prompt-and-parse LLM calls, permission checks, or classifiers that should use calibrated Jev primitives.",
      argsSchema: {
        targetPath: z.string().optional().describe("Directory or file path to audit."),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Audit ${args.targetPath || "this codebase"} for every LLM call doing classification, boolean verification, sentiment/urgency scoring, RAG filtering, date extraction, or tool-call gating instead of TypeSafe Jev (${PINNED_JEV_MODEL}). For each candidate:\n1. Design parallel Noul/Choice/Score questions avoiding TypeSafe jaggedness (counting, math, date math, inverted polarity, degree Noul, bare Score numbers).\n2. Validate each proposed payload offline with jev_lint_design.\n3. Ensure fail-closed refusal handling, pinned models, and deterministic pre-checks.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "jev-calibrate-workflow",
    {
      title: "Run End-to-End Jev Auto-Calibration",
      description: "Guide calibrating thresholds and 1D temperature scaling on labeled samples plus consistency audit.",
      argsSchema: {
        profileId: z.string().describe("Target profileId to create or update."),
        taskGoal: z.string().optional().describe("Decision task being calibrated."),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Calibrate profile '${args.profileId}'${args.taskGoal ? ` for: ${args.taskGoal}` : ""}.\nSteps:\n1. Pin model to '${PINNED_JEV_MODEL}'.\n2. Run jev_lint_design on a sample payload first.\n3. Execute jev_calibrate_auto with checkConsistency=true and appropriate SLA targets (e.g. minApprovePrecision=0.95 for safety gates).\n4. Inspect Before/After ECE, Brier, NLL, and confidence bands (<0.5, 0.5-0.8, >=0.8).\n5. Demonstrate $0 offline re-tuning with jev_calibration_profiles(action='retune').`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "jev-design-decision",
    {
      title: "Decompose Task into Jev Primitives",
      description: "Break a complex judgment into parallel Nouls, contrastive Choice schemas, descriptive Scores, or Box + Companion Noul.",
      argsSchema: {
        problem: z.string().describe("Workflow or judgment problem to decompose."),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Decompose the following workflow into optimal TypeSafe Jev System One primitives (and run jev_lint_design to verify zero jaggedness errors/warnings):\n\n${args.problem}`,
          },
        },
      ],
    }),
  );

  return server;
}
