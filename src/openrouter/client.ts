import { loadRuntimeConfig, resolveOpenRouterApiKey } from "../config/runtimeConfig.js";
import {
  DecisionResponseSchema,
  JEV_PRICE_PER_MILLION_INPUT_TOKENS_USD,
  JEV_ROUTER_MODEL,
  OPENROUTER_DECISIONS_PATH,
  OPENROUTER_KEY_PATH,
  OPENROUTER_MODELS_PATH,
  OPENROUTER_RESPONSES_PATH,
  OPENROUTER_SYSTEMONE_PATH,
  type DecisionAnswer,
  type DecisionRequestOptions,
  type DecisionResponse,
  type PluginRuntimeConfig,
  type ProviderRouting,
  type RefusalAnswer,
} from "../types/decisions.js";
import { extractConfidence } from "../typesafe/confidence.js";

export class OpenRouterApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly limitSource?: string;
  readonly remedyHint?: string;
  readonly resetsAt?: string;

  constructor(
    message: string,
    opts: {
      status: number;
      retryable: boolean;
      retryAfterMs?: number;
      limitSource?: string;
      remedyHint?: string;
      resetsAt?: string;
    },
  ) {
    super(message);
    this.name = "OpenRouterApiError";
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
    this.limitSource = opts.limitSource;
    this.remedyHint = opts.remedyHint;
    this.resetsAt = opts.resetsAt;
  }
}

export class DecisionRefusalError extends Error {
  readonly refusals: Array<{ questionId: string; reason: string }>;
  readonly response: DecisionResponse;

  constructor(
    refusals: Array<{ questionId: string; reason: string }>,
    response: DecisionResponse,
  ) {
    super(
      `Fail-closed refusal from model '${response.model}' on: ${refusals
        .map((r) => `${r.questionId} (${r.reason})`)
        .join(", ")}`,
    );
    this.name = "DecisionRefusalError";
    this.refusals = refusals;
    this.response = response;
  }
}

export function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    return Math.max(0, parsedDate - Date.now());
  }
  return undefined;
}

export interface DecisionExecutionResult {
  response: DecisionResponse;
  modelRequested: string;
  endpointUsed: string;
  latencyMs: number;
  attempts: number;
  estimatedCostUsd: number;
  reportedCostUsd?: number;
  cachedTokens: number;
  confidences: Record<string, number>;
  refusals: Array<{ questionId: string; reason: string }>;
}

export interface BatchItemInput {
  id: string;
  state: unknown;
  questions?: DecisionRequestOptions["questions"];
  assets?: DecisionRequestOptions["assets"];
}

export interface BatchExecutionResult<T = unknown> {
  model: string;
  concurrency: number;
  totalItems: number;
  succeededCount: number;
  failedCount: number;
  refusalCount: number;
  totalCostUsd: number;
  costPer1kItemsUsd: number;
  totalInputTokens: number;
  totalCachedTokens: number;
  totalOutputTokens: number;
  durationMs: number;
  results: Array<
    | {
        id: string;
        ok: true;
        execution: DecisionExecutionResult;
        extra?: T;
      }
    | {
        id: string;
        ok: false;
        error: string;
        status?: number;
        limitSource?: string;
        remedyHint?: string;
      }
  >;
}

export class OpenRouterJevClient {
  private readonly apiKeyOverride?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(opts?: {
    apiKey?: string;
    fetchImpl?: typeof fetch;
    sleepFn?: (ms: number) => Promise<void>;
  }) {
    this.apiKeyOverride = opts?.apiKey;
    this.fetchImpl = opts?.fetchImpl ?? fetch;
    this.sleepFn = opts?.sleepFn ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
  }

  private getConfig(): PluginRuntimeConfig {
    return loadRuntimeConfig();
  }

  private requireApiKey(): string {
    const key = this.apiKeyOverride?.trim() || resolveOpenRouterApiKey();
    if (!key) {
      throw new OpenRouterApiError(
        "OPENROUTER_API_KEY is not configured. Add your OpenRouter API key (https://openrouter.ai/settings/keys) in Antigravity Plugin settings/variables or export OPENROUTER_API_KEY.",
        { status: 401, retryable: false, limitSource: "missing_api_key" },
      );
    }
    return key;
  }

  private buildHeaders(
    cfg: PluginRuntimeConfig,
    apiKey: string,
    opts?: {
      longContext?: boolean;
      imagesOptIn?: boolean;
      responseCache?: boolean;
      cacheTtlSeconds?: number;
      cacheClear?: boolean;
      extraHeaders?: Record<string, string>;
    },
  ): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": cfg.httpReferer,
      "X-OpenRouter-Title": cfg.appTitle,
      "X-Title": cfg.appTitle,
    };
    if (cfg.appCategories) {
      headers["X-OpenRouter-Categories"] = cfg.appCategories;
    }
    if (cfg.appVisibility === "hidden") {
      headers["X-OpenRouter-App-Visibility"] = "hidden";
    }
    if (opts?.longContext) {
      headers["TypeSafe-Danger-Zone-Long-Context"] = "true";
    }
    if (opts?.imagesOptIn) {
      headers["TypeSafe-Danger-Zone-Images"] = "true";
    }
    const cacheEnabled = opts?.responseCache ?? cfg.defaultCacheEnabled;
    if (opts?.responseCache !== undefined || cfg.defaultCacheEnabled) {
      headers["X-OpenRouter-Cache"] = cacheEnabled ? "true" : "false";
    }
    const ttl = opts?.cacheTtlSeconds ?? cfg.defaultCacheTtlSeconds;
    if (ttl !== undefined) {
      headers["X-OpenRouter-Cache-TTL"] = String(ttl);
    }
    if (opts?.cacheClear) {
      headers["X-OpenRouter-Cache-Clear"] = "true";
    }
    if (opts?.extraHeaders) {
      Object.assign(headers, opts.extraHeaders);
    }
    return headers;
  }

  private async requestWithRetry(
    url: string,
    init: RequestInit,
    opts: { timeoutMs: number; maxRetries: number },
  ): Promise<{ json: unknown; attempts: number }> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= opts.maxRetries + 1; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          ...init,
          signal: AbortSignal.timeout(opts.timeoutMs),
        });

        const text = await res.text();
        let parsedBody: unknown;
        try {
          parsedBody = text ? JSON.parse(text) : {};
        } catch {
          parsedBody = { raw: text };
        }

        if (res.ok) {
          return { json: parsedBody, attempts: attempt };
        }

        const errObj =
          parsedBody && typeof parsedBody === "object" && "error" in parsedBody
            ? ((parsedBody as { error?: Record<string, unknown> }).error ?? {})
            : {};
        const metadata =
          errObj.metadata && typeof errObj.metadata === "object"
            ? (errObj.metadata as Record<string, unknown>)
            : {};

        const limitSource =
          typeof metadata.limit_source === "string" ? metadata.limit_source : undefined;
        const remedyHint =
          typeof metadata.remedy_hint === "string" ? metadata.remedy_hint : undefined;
        const resetsAt =
          typeof metadata.resets_at === "string" ? metadata.resets_at : undefined;
        const errMessage =
          typeof errObj.message === "string"
            ? errObj.message
            : `OpenRouter HTTP ${res.status}: ${text.slice(0, 300)}`;

        const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
        const isInFlightBudget402 =
          res.status === 402 && limitSource === "openrouter_in_flight_budget";
        const retryable =
          res.status === 429 ||
          res.status >= 500 ||
          isInFlightBudget402;

        const apiErr = new OpenRouterApiError(errMessage, {
          status: res.status,
          retryable,
          retryAfterMs,
          limitSource,
          remedyHint,
          resetsAt,
        });

        if (!retryable || attempt > opts.maxRetries) {
          throw apiErr;
        }

        const exponentialMs = 350 * 2 ** (attempt - 1);
        const jitterMs = Math.floor(Math.random() * 200);
        const waitMs = Math.min(30_000, Math.max(retryAfterMs ?? 0, exponentialMs) + jitterMs);
        lastError = apiErr;
        await this.sleepFn(waitMs);
      } catch (err) {
        if (err instanceof OpenRouterApiError && !err.retryable) {
          throw err;
        }
        const wrapped =
          err instanceof OpenRouterApiError
            ? err
            : new OpenRouterApiError(
                err instanceof Error ? err.message : "Network/timeout error calling OpenRouter",
                { status: 0, retryable: true },
              );
        lastError = wrapped;
        if (attempt > opts.maxRetries) {
          throw wrapped;
        }
        const exponentialMs = 350 * 2 ** (attempt - 1);
        const jitterMs = Math.floor(Math.random() * 200);
        await this.sleepFn(Math.min(20_000, exponentialMs + jitterMs));
      }
    }

    throw lastError ?? new Error("Exhausted OpenRouter request retries");
  }

  async decide(options: DecisionRequestOptions): Promise<DecisionExecutionResult> {
    const cfg = this.getConfig();
    const apiKey = this.requireApiKey();
    const modelRequested = options.model?.trim() || cfg.defaultModel;
    const timeoutMs = options.timeoutMs ?? cfg.timeoutMs;
    const maxRetries = options.maxRetries ?? cfg.maxRetries;

    const mergedProvider: ProviderRouting | undefined = (() => {
      const p: ProviderRouting = { ...(options.provider ?? {}) };
      if (p.zdr === undefined && cfg.zdr) p.zdr = true;
      if (p.preferred_max_latency === undefined && cfg.preferredMaxLatencyP90 !== undefined) {
        p.preferred_max_latency = { p90: cfg.preferredMaxLatencyP90 };
      }
      return Object.keys(p).length > 0 ? p : undefined;
    })();

    const endpointPath =
      options.endpointMode === "systemone"
        ? OPENROUTER_SYSTEMONE_PATH
        : OPENROUTER_DECISIONS_PATH;
    const url = `${cfg.baseUrl.replace(/\/$/, "")}${endpointPath}`;

    const body: Record<string, unknown> = {
      model: modelRequested,
      state: options.state,
      questions: options.questions,
    };
    if (options.assets && Object.keys(options.assets).length > 0) {
      body.assets = options.assets;
    }
    if (mergedProvider) {
      body.provider = mergedProvider;
    }
    if (options.sessionId) {
      body.session_id = options.sessionId;
    }
    if (options.user) {
      body.user = options.user;
    }

    const hasBoxOrAssets =
      Boolean(options.assets && Object.keys(options.assets).length > 0) ||
      Object.values(options.questions).some((q) => q.type === "box");

    const headers = this.buildHeaders(cfg, apiKey, {
      longContext: options.longContext,
      imagesOptIn: options.imagesOptIn ?? (hasBoxOrAssets ? true : undefined),
      responseCache: options.responseCache,
      cacheTtlSeconds: options.cacheTtlSeconds,
      cacheClear: options.cacheClear,
    });

    const startedAt = Date.now();
    const { json, attempts } = await this.requestWithRetry(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
      { timeoutMs, maxRetries },
    );
    const latencyMs = Date.now() - startedAt;

    const parsed = DecisionResponseSchema.parse(json);

    // Fail-closed: verify every requested question was answered
    const requestedIds = Object.keys(options.questions);
    const missing = requestedIds.filter((qId) => parsed.answers[qId] === undefined);
    if (missing.length > 0) {
      throw new Error(`Incomplete Decisions response; missing answers for: ${missing.join(", ")}`);
    }

    const refusals: Array<{ questionId: string; reason: string }> = [];
    const confidences: Record<string, number> = {};

    for (const qId of requestedIds) {
      const answer: DecisionAnswer = parsed.answers[qId]!;
      confidences[qId] = extractConfidence(answer);
      if (answer.type === "refusal") {
        const ref = answer as RefusalAnswer;
        refusals.push({
          questionId: qId,
          reason: ref.reason ?? ref.refusal ?? ref.message ?? "Model refused to answer question",
        });
      }
    }

    if (refusals.length > 0 && options.failOnRefusal !== false) {
      throw new DecisionRefusalError(refusals, parsed);
    }

    const inputTokens = parsed.usage?.input_tokens ?? 0;
    const cachedTokens = parsed.usage?.input_tokens_details?.cached_tokens ?? 0;
    const reportedCostUsd =
      typeof parsed.usage?.cost === "number" ? parsed.usage.cost : undefined;
    const estimatedCostUsd =
      reportedCostUsd ?? (inputTokens / 1_000_000) * JEV_PRICE_PER_MILLION_INPUT_TOKENS_USD;

    return {
      response: parsed,
      modelRequested,
      endpointUsed: endpointPath,
      latencyMs,
      attempts,
      estimatedCostUsd,
      reportedCostUsd,
      cachedTokens,
      confidences,
      refusals,
    };
  }

  async runBatch(opts: {
    items: BatchItemInput[];
    sharedQuestions?: DecisionRequestOptions["questions"];
    model?: string;
    concurrency?: number;
    provider?: ProviderRouting;
    sessionId?: string;
    user?: string;
    responseCache?: boolean;
    failOnRefusal?: boolean;
    longContext?: boolean;
    timeoutMs?: number;
    maxRetries?: number;
  }): Promise<BatchExecutionResult> {
    const cfg = this.getConfig();
    const concurrency = Math.max(1, Math.min(32, opts.concurrency ?? cfg.defaultConcurrency));
    const model = opts.model?.trim() || cfg.defaultModel;
    const startedAt = Date.now();

    const outResults: BatchExecutionResult["results"] = new Array(opts.items.length);
    let cursor = 0;
    let pausedUntil = 0;
    let totalCostUsd = 0;
    let totalInputTokens = 0;
    let totalCachedTokens = 0;
    let totalOutputTokens = 0;
    let succeededCount = 0;
    let failedCount = 0;
    let refusalCount = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const idx = cursor++;
        if (idx >= opts.items.length) return;

        const pauseMs = pausedUntil - Date.now();
        if (pauseMs > 0) {
          await this.sleepFn(pauseMs);
        }

        const item = opts.items[idx]!;
        const questions = item.questions ?? opts.sharedQuestions;
        if (!questions || Object.keys(questions).length === 0) {
          failedCount++;
          outResults[idx] = {
            id: item.id,
            ok: false,
            error: "No questions provided for item or batch.",
          };
          continue;
        }

        try {
          const execution = await this.decide({
            model,
            state: item.state,
            questions,
            assets: item.assets,
            provider: opts.provider,
            sessionId: opts.sessionId,
            user: opts.user,
            responseCache: opts.responseCache,
            failOnRefusal: opts.failOnRefusal,
            longContext: opts.longContext,
            timeoutMs: opts.timeoutMs,
            maxRetries: opts.maxRetries,
          });
          succeededCount++;
          if (execution.refusals.length > 0) refusalCount++;
          totalCostUsd += execution.estimatedCostUsd;
          totalInputTokens += execution.response.usage?.input_tokens ?? 0;
          totalCachedTokens += execution.cachedTokens;
          totalOutputTokens += execution.response.usage?.output_tokens ?? 0;
          outResults[idx] = { id: item.id, ok: true, execution };
        } catch (err) {
          if (err instanceof OpenRouterApiError) {
            if (err.retryable) {
              const wait = err.retryAfterMs ?? 2000;
              pausedUntil = Math.max(pausedUntil, Date.now() + wait);
            }
            failedCount++;
            outResults[idx] = {
              id: item.id,
              ok: false,
              error: err.message,
              status: err.status,
              limitSource: err.limitSource,
              remedyHint: err.remedyHint,
            };
          } else if (err instanceof DecisionRefusalError) {
            refusalCount++;
            failedCount++;
            outResults[idx] = {
              id: item.id,
              ok: false,
              error: err.message,
            };
          } else {
            failedCount++;
            outResults[idx] = {
              id: item.id,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, Math.max(1, opts.items.length)) }, () =>
      worker(),
    );
    await Promise.all(workers);

    const processedCount = succeededCount;
    const costPer1kItemsUsd = processedCount > 0 ? (totalCostUsd / processedCount) * 1000 : 0;

    return {
      model,
      concurrency,
      totalItems: opts.items.length,
      succeededCount,
      failedCount,
      refusalCount,
      totalCostUsd,
      costPer1kItemsUsd,
      totalInputTokens,
      totalCachedTokens,
      totalOutputTokens,
      durationMs: Date.now() - startedAt,
      results: outResults,
    };
  }

  async listDecisionModels(opts?: {
    inputModalities?: string[];
    zdrOnly?: boolean;
  }): Promise<unknown> {
    const cfg = this.getConfig();
    const apiKey = resolveOpenRouterApiKey();
    const url = new URL(`${cfg.baseUrl.replace(/\/$/, "")}${OPENROUTER_MODELS_PATH}`);
    url.searchParams.set("output_modalities", "decisions");
    if (opts?.inputModalities && opts.inputModalities.length > 0) {
      url.searchParams.set("input_modalities", opts.inputModalities.join(","));
    }
    if (opts?.zdrOnly) {
      url.searchParams.set("zdr", "true");
    }

    const headers: Record<string, string> = {
      "HTTP-Referer": cfg.httpReferer,
      "X-OpenRouter-Title": cfg.appTitle,
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const { json } = await this.requestWithRetry(
      url.toString(),
      { method: "GET", headers },
      { timeoutMs: cfg.timeoutMs, maxRetries: 2 },
    );
    return json;
  }

  async getKeyStatus(): Promise<unknown> {
    const cfg = this.getConfig();
    const apiKey = this.requireApiKey();
    const url = `${cfg.baseUrl.replace(/\/$/, "")}${OPENROUTER_KEY_PATH}`;
    const { json } = await this.requestWithRetry(
      url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": cfg.httpReferer,
          "X-OpenRouter-Title": cfg.appTitle,
        },
      },
      { timeoutMs: cfg.timeoutMs, maxRetries: 2 },
    );
    return json;
  }

  async callJevRouter(opts: {
    model?: string;
    input: unknown;
    instructions?: string;
    costTier?: "low" | "medium" | "high";
    reasoningEffort?: "minimal" | "low" | "medium" | "high";
    models?: string[];
    allowedModels?: string[];
    excludedModels?: string[];
    maxOutputTokens?: number;
    sessionId?: string;
    user?: string;
    includeRoutingMetadata?: boolean;
  }): Promise<unknown> {
    const cfg = this.getConfig();
    const apiKey = this.requireApiKey();
    const url = `${cfg.baseUrl.replace(/\/$/, "")}${OPENROUTER_RESPONSES_PATH}`;

    const pluginConfig: Record<string, unknown> = { id: "jev-router" };
    if (opts.costTier) pluginConfig.cost_tier = opts.costTier;
    if (opts.models) pluginConfig.models = opts.models;
    if (opts.allowedModels) pluginConfig.allowed_models = opts.allowedModels;
    if (opts.excludedModels) pluginConfig.excluded_models = opts.excludedModels;

    const hasPluginOverrides = Object.keys(pluginConfig).length > 1;
    const body: Record<string, unknown> = {
      model: opts.model?.trim() || JEV_ROUTER_MODEL,
      input: opts.input,
      stream: false,
    };
    if (opts.instructions) body.instructions = opts.instructions;
    if (opts.reasoningEffort) body.reasoning = { effort: opts.reasoningEffort };
    if (opts.maxOutputTokens) body.max_output_tokens = opts.maxOutputTokens;
    if (opts.sessionId) body.session_id = opts.sessionId;
    if (opts.user) body.user = opts.user;
    if (hasPluginOverrides) body.plugins = [pluginConfig];

    const headers = this.buildHeaders(cfg, apiKey, {
      extraHeaders:
        opts.includeRoutingMetadata !== false
          ? { "X-OpenRouter-Metadata": "enabled" }
          : undefined,
    });

    const { json } = await this.requestWithRetry(
      url,
      { method: "POST", headers, body: JSON.stringify(body) },
      { timeoutMs: Math.max(cfg.timeoutMs, 60_000), maxRetries: cfg.maxRetries },
    );
    return json;
  }

  async callResponsesModel(opts: {
    model: string;
    instructions?: string;
    input: unknown;
    maxOutputTokens?: number;
    sessionId?: string;
  }): Promise<{ text: string; costUsd?: number; raw: unknown }> {
    const cfg = this.getConfig();
    const apiKey = this.requireApiKey();
    const url = `${cfg.baseUrl.replace(/\/$/, "")}${OPENROUTER_RESPONSES_PATH}`;
    const body: Record<string, unknown> = {
      model: opts.model,
      input: opts.input,
      stream: false,
    };
    if (opts.instructions) body.instructions = opts.instructions;
    if (opts.maxOutputTokens) body.max_output_tokens = opts.maxOutputTokens;
    if (opts.sessionId) body.session_id = opts.sessionId;

    const headers = this.buildHeaders(cfg, apiKey);
    const { json } = await this.requestWithRetry(
      url,
      { method: "POST", headers, body: JSON.stringify(body) },
      { timeoutMs: Math.max(cfg.timeoutMs, 60_000), maxRetries: cfg.maxRetries },
    );

    const record = json as {
      status?: string;
      output_text?: string;
      output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
      usage?: { cost?: number };
    };
    if (record.status && record.status !== "completed") {
      throw new Error(`Responses API returned incomplete status: ${record.status}`);
    }
    const text =
      typeof record.output_text === "string"
        ? record.output_text
        : (record.output
            ?.find((item) => item.type === "message")
            ?.content?.find((p) => p.type === "output_text")?.text ?? "");

    if (typeof text !== "string" || text.length === 0) {
      throw new Error("Responses API returned empty text output");
    }

    return {
      text,
      costUsd: typeof record.usage?.cost === "number" ? record.usage.cost : undefined,
      raw: json,
    };
  }
}
