import { z } from "zod";

export const PINNED_JEV_MODEL = "typesafe/jev-1.14";
export const LATEST_JEV_ALIAS = "~typesafe/jev-latest";
export const JEV_1_13_MODEL = "typesafe/jev-1.13";
export const JEV_ROUTER_MODEL = "typesafe/jev-router";

export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai";
export const OPENROUTER_DECISIONS_PATH = "/api/alpha/decisions";
export const OPENROUTER_SYSTEMONE_PATH = "/api/v1/systemone";
export const OPENROUTER_MODELS_PATH = "/api/v1/models";
export const OPENROUTER_KEY_PATH = "/api/v1/key";
export const OPENROUTER_RESPONSES_PATH = "/api/v1/responses";

export const JEV_PRICE_PER_MILLION_INPUT_TOKENS_USD = 0.042;
export const JEV_DEFAULT_PER_REQUEST_CONTEXT_TOKENS = 64_000;
export const JEV_DEFAULT_PER_QUESTION_CONTEXT_TOKENS = 32_000;
export const JEV_LONG_CONTEXT_TOKENS = 262_144;

export const DEFAULT_NOUL_YES_THRESHOLD = 0.7;
export const DEFAULT_NOUL_NO_THRESHOLD = 0.3;
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
export const DEFAULT_HIGH_STAKES_APPROVE_THRESHOLD = 0.9;
export const DEFAULT_HIGH_STAKES_BLOCK_THRESHOLD = 0.1;

export type StructuredContent = unknown;

export const NoulCriteriaSchema = z
  .object({
    true: z.unknown().optional(),
    false: z.unknown().optional(),
  })
  .catchall(z.unknown());

export const NoulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: z.unknown(),
  criteria: NoulCriteriaSchema.optional(),
});

export const ChoiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: z.unknown(),
  criteria: z.record(z.string(), z.unknown()),
});

export const ScoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: z.unknown(),
  criteria: z.array(z.unknown()).min(2).max(10),
});

export const BoxQuestionSchema = z.object({
  type: z.literal("box"),
  instructions: z.unknown(),
});

export const DecisionQuestionSchema = z.discriminatedUnion("type", [
  NoulQuestionSchema,
  ChoiceQuestionSchema,
  ScoreQuestionSchema,
  BoxQuestionSchema,
]);

export type NoulQuestion = z.infer<typeof NoulQuestionSchema>;
export type ChoiceQuestion = z.infer<typeof ChoiceQuestionSchema>;
export type ScoreQuestion = z.infer<typeof ScoreQuestionSchema>;
export type BoxQuestion = z.infer<typeof BoxQuestionSchema>;
export type DecisionQuestion = z.infer<typeof DecisionQuestionSchema>;

export const AssetEntrySchema = z.object({
  type: z.literal("image").optional(),
  format: z.enum(["png", "jpg", "jpeg"]).optional(),
  data_base64: z.string().optional(),
  part: z.string().optional(),
});

export type AssetEntry = z.infer<typeof AssetEntrySchema>;

export const ProviderRoutingSchema = z
  .object({
    zdr: z.boolean().optional(),
    allow_fallbacks: z.boolean().optional(),
    require_parameters: z.boolean().optional(),
    data_collection: z.enum(["allow", "deny"]).optional(),
    order: z.array(z.string()).optional(),
    only: z.array(z.string()).optional(),
    ignore: z.array(z.string()).optional(),
    sort: z
      .union([
        z.string(),
        z.object({
          by: z.string(),
          partition: z.enum(["model", "none"]).optional(),
        }),
      ])
      .optional(),
    preferred_max_latency: z
      .union([z.number(), z.record(z.string(), z.number())])
      .optional(),
    preferred_min_throughput: z
      .union([z.number(), z.record(z.string(), z.number())])
      .optional(),
  })
  .catchall(z.unknown());

export type ProviderRouting = z.infer<typeof ProviderRoutingSchema>;

export const NoulAnswerSchema = z.object({
  type: z.literal("noul"),
  noul: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1).optional(),
});

export const ChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
  confidence: z.number().min(0).max(1).optional(),
});

export const ScoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number(),
  legend: z.record(z.string(), z.unknown()).optional(),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
  confidence: z.number().min(0).max(1).optional(),
});

export const BoxCoordinatesSchema = z.object({
  top: z.number().min(0).max(1),
  bottom: z.number().min(0).max(1),
  left: z.number().min(0).max(1),
  right: z.number().min(0).max(1),
});

export const BoxAnswerSchema = z.object({
  type: z.literal("box"),
  box: BoxCoordinatesSchema,
  confidence: z.number().min(0).max(1).optional(),
});

export const RefusalAnswerSchema = z.object({
  type: z.literal("refusal"),
  reason: z.string().optional(),
  refusal: z.string().optional(),
  message: z.string().optional(),
});

export const DecisionAnswerSchema = z.discriminatedUnion("type", [
  NoulAnswerSchema,
  ChoiceAnswerSchema,
  ScoreAnswerSchema,
  BoxAnswerSchema,
  RefusalAnswerSchema,
]);

export type NoulAnswer = z.infer<typeof NoulAnswerSchema>;
export type ChoiceAnswer = z.infer<typeof ChoiceAnswerSchema>;
export type ScoreAnswer = z.infer<typeof ScoreAnswerSchema>;
export type BoxAnswer = z.infer<typeof BoxAnswerSchema>;
export type RefusalAnswer = z.infer<typeof RefusalAnswerSchema>;
export type DecisionAnswer = z.infer<typeof DecisionAnswerSchema>;

export const UsageSchema = z
  .object({
    input_tokens: z.number().nonnegative().optional(),
    output_tokens: z.number().nonnegative().optional(),
    cost: z.number().nonnegative().optional(),
    input_tokens_details: z
      .object({
        cached_tokens: z.number().nonnegative().optional(),
      })
      .catchall(z.unknown())
      .optional(),
  })
  .catchall(z.unknown());

export const DecisionResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string(),
  provider: z.string().optional(),
  answers: z.record(z.string(), DecisionAnswerSchema),
  usage: UsageSchema.optional(),
});

export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;

export interface DecisionRequestOptions {
  model?: string;
  state: unknown;
  questions: Record<string, DecisionQuestion>;
  assets?: Record<string, AssetEntry>;
  provider?: ProviderRouting;
  sessionId?: string;
  user?: string;
  longContext?: boolean;
  imagesOptIn?: boolean;
  responseCache?: boolean;
  cacheTtlSeconds?: number;
  cacheClear?: boolean;
  failOnRefusal?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  endpointMode?: "decisions" | "systemone";
}

export interface PluginRuntimeConfig {
  defaultModel: string;
  baseUrl: string;
  httpReferer: string;
  appTitle: string;
  appCategories: string;
  appVisibility: "public" | "hidden";
  zdr: boolean;
  preferredMaxLatencyP90?: number;
  defaultCacheEnabled: boolean;
  defaultCacheTtlSeconds?: number;
  defaultConcurrency: number;
  timeoutMs: number;
  maxRetries: number;
  defaultNoulYesThreshold: number;
  defaultNoulNoThreshold: number;
  defaultConfidenceThreshold: number;
  dataDir?: string;
}

export const PluginRuntimeConfigPatchSchema = z.object({
  defaultModel: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  httpReferer: z.string().url().optional(),
  appTitle: z.string().min(1).optional(),
  appCategories: z.string().optional(),
  appVisibility: z.enum(["public", "hidden"]).optional(),
  zdr: z.boolean().optional(),
  preferredMaxLatencyP90: z.number().positive().nullable().optional(),
  defaultCacheEnabled: z.boolean().optional(),
  defaultCacheTtlSeconds: z.number().int().min(1).max(86400).nullable().optional(),
  defaultConcurrency: z.number().int().min(1).max(64).optional(),
  timeoutMs: z.number().int().min(1000).max(300_000).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  defaultNoulYesThreshold: z.number().min(0.5).max(1).optional(),
  defaultNoulNoThreshold: z.number().min(0).max(0.5).optional(),
  defaultConfidenceThreshold: z.number().min(0).max(1).optional(),
});
