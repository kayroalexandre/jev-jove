import {
  JEV_1_13_MODEL,
  type AssetEntry,
  type DecisionQuestion,
} from "../types/decisions.js";

export type LintSeverity = "error" | "warning" | "tip";

export interface LintDiagnostic {
  code: string;
  severity: LintSeverity;
  questionId?: string;
  message: string;
  recommendation: string;
}

export interface LintDesignInput {
  model?: string;
  state: unknown;
  questions: Record<string, DecisionQuestion>;
  assets?: Record<string, AssetEntry>;
  longContext?: boolean;
  imagesOptIn?: boolean;
  calibrated?: boolean;
}

export interface LintDesignReport {
  status: "pass" | "warn" | "fail";
  score: number;
  metrics: {
    questionCount: number;
    stateUtf8Bytes: number;
    maxJsonDepth: number;
    assetCount: number;
    hasImages: boolean;
    hasBoxQuestion: boolean;
  };
  diagnostics: LintDiagnostic[];
}

function measureJsonDepthAndFiniteNumbers(
  value: unknown,
  currentDepth = 0,
): { maxDepth: number; nonFinitePaths: string[] } {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      return { maxDepth: currentDepth, nonFinitePaths: ["root"] };
    }
    return { maxDepth: currentDepth, nonFinitePaths: [] };
  }

  let maxDepth = currentDepth + 1;
  const nonFinitePaths: string[] = [];

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const sub = measureJsonDepthAndFiniteNumbers(value[i], currentDepth + 1);
      if (sub.maxDepth > maxDepth) maxDepth = sub.maxDepth;
      for (const p of sub.nonFinitePaths) {
        nonFinitePaths.push(`[${i}].${p}`);
      }
    }
  } else {
    for (const [k, v] of Object.entries(value)) {
      const sub = measureJsonDepthAndFiniteNumbers(v, currentDepth + 1);
      if (sub.maxDepth > maxDepth) maxDepth = sub.maxDepth;
      for (const p of sub.nonFinitePaths) {
        nonFinitePaths.push(`${k}.${p}`);
      }
    }
  }

  return { maxDepth, nonFinitePaths };
}

function stringifyTextForHeuristics(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function containsImageParts(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some(containsImageParts);
  }
  const rec = value as Record<string, unknown>;
  if (rec.type === "image_url" && typeof rec.image_url === "object" && rec.image_url !== null) {
    return true;
  }
  return Object.values(rec).some(containsImageParts);
}

function collectInvalidImageDataUrls(value: unknown, found: string[] = []): string[] {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const item of value) collectInvalidImageDataUrls(item, found);
    return found;
  }
  const rec = value as Record<string, unknown>;
  if (rec.type === "image_url" && typeof rec.image_url === "object" && rec.image_url !== null) {
    const url = (rec.image_url as Record<string, unknown>).url;
    if (typeof url === "string") {
      const isPngOrJpgDataUrl = /^data:image\/(png|jpeg|jpg);base64,/i.test(url);
      if (!isPngOrJpgDataUrl) {
        found.push(url.slice(0, 64));
      }
    }
  }
  for (const val of Object.values(rec)) {
    collectInvalidImageDataUrls(val, found);
  }
  return found;
}

const COUNTING_PATTERN = /\b(how many|count (the|all|each)|number of occurrences|total count|quantos|quantas|contar)\b/i;
const DATE_MATH_PATTERN =
  /\b(how many days|days ago|more than \d+ days|before or after|which date is (earlier|later)|calculate|sum of|total price|greater than|quantos dias|calcular)\b/i;
const DEGREE_WORD_PATTERN =
  /\b(how (much|strong|severe|frustrated|likely|good)|degree of|level of|quão|nível de)\b/i;
const NEGATED_NOUL_PATTERN =
  /\b(is (this|it|the)( \w+){0,2} (free of|without|not)|does not contain|no [a-z]+ present|não contém|livre de)\b/i;
const COMPOUND_CONDITION_PATTERN =
  /\b(and also|and is the|both .* and|e também|e se o)\b/i;
const UNTRUSTED_STATE_KEYS =
  /(message|email|comment|ticket|reply|body|prompt|user_input|review|post|texto|mensagem)/i;

export function lintDesign(input: LintDesignInput): LintDesignReport {
  const diagnostics: LintDiagnostic[] = [];
  const model = input.model ?? "typesafe/jev-1.14";
  const questionEntries = Object.entries(input.questions);
  const questionIds = new Set(questionEntries.map(([id]) => id));
  const assetEntries = Object.entries(input.assets ?? {});

  const serializedRequest = JSON.stringify({
    state: input.state,
    questions: input.questions,
    assets: input.assets,
  });
  const stateUtf8Bytes = Buffer.byteLength(JSON.stringify(input.state ?? ""), "utf8");
  const totalBytes = Buffer.byteLength(serializedRequest, "utf8");
  const { maxDepth, nonFinitePaths } = measureJsonDepthAndFiniteNumbers({
    state: input.state,
    questions: input.questions,
  });

  const hasBoxQuestion = questionEntries.some(([, q]) => q.type === "box");
  const hasImages =
    assetEntries.length > 0 ||
    containsImageParts(input.state) ||
    containsImageParts(input.questions);

  // 1. Hard API request rules (docs.typesafe.ai/api/errors)
  if (totalBytes > 32 * 1024 * 1024) {
    diagnostics.push({
      code: "BODY_TOO_LARGE",
      severity: "error",
      message: `Request size (${(totalBytes / (1024 * 1024)).toFixed(2)} MiB) exceeds the 32 MiB limit.`,
      recommendation: "Filter state fields in code, resize images (<=1568px), or split batches.",
    });
  }

  if (maxDepth > 64) {
    diagnostics.push({
      code: "NESTING_DEPTH_EXCEEDED",
      severity: "error",
      message: `JSON nesting depth (${maxDepth}) exceeds TypeSafe's maximum of 64 levels.`,
      recommendation: "Flatten deeply nested structures in code before sending to Jev.",
    });
  }

  if (nonFinitePaths.length > 0) {
    diagnostics.push({
      code: "NON_FINITE_NUMBERS",
      severity: "error",
      message: `Detected NaN or Infinity at: ${nonFinitePaths.slice(0, 3).join(", ")}.`,
      recommendation: "Send only finite numbers; pass large identifiers/decimals as strings.",
    });
  }

  // 2. Model compatibility for Box & pinning warnings
  if (hasBoxQuestion && model.startsWith(JEV_1_13_MODEL)) {
    diagnostics.push({
      code: "BOX_UNSUPPORTED_ON_1_13",
      severity: "error",
      message: `Model '${model}' rejects Box questions with HTTP 400.`,
      recommendation: "Use 'typesafe/jev-1.14' or '~typesafe/jev-latest' for Box questions.",
    });
  }

  if (input.calibrated && (model.includes("latest") || model.includes("preview"))) {
    diagnostics.push({
      code: "UNPINNED_MODEL_FOR_CALIBRATED_SYSTEM",
      severity: "warning",
      message: `Floating alias '${model}' changes behavior when new releases ship, breaking calibrated thresholds.`,
      recommendation: "Pin a concrete model version such as 'typesafe/jev-1.14' once calibrated.",
    });
  }

  // 3. Asset reference verification (unused asset returns 400)
  const haystacks = [
    stringifyTextForHeuristics(input.state),
    stringifyTextForHeuristics(input.questions),
  ].join("\n");

  for (const [assetKey, asset] of assetEntries) {
    if (!haystacks.includes(assetKey)) {
      diagnostics.push({
        code: "UNREFERENCED_ASSET",
        severity: "error",
        message: `Asset '${assetKey}' is declared in assets but never referenced in state, instructions, or criteria (causes HTTP 400).`,
        recommendation: `Reference '${assetKey}' in state/instructions/criteria or remove it from assets.`,
      });
    }
    if (asset.data_base64 && /^data:/i.test(asset.data_base64)) {
      diagnostics.push({
        code: "ASSET_BASE64_HAS_DATA_PREFIX",
        severity: "error",
        message: `Asset '${assetKey}' data_base64 includes a 'data:' prefix; TypeSafe expects raw base64 with 'format'.`,
        recommendation: "Strip 'data:image/...;base64,' from assets[].data_base64 (use data URLs only inside image_url parts).",
      });
    }
  }

  const invalidImageUrls = collectInvalidImageDataUrls({
    state: input.state,
    questions: input.questions,
  });
  if (invalidImageUrls.length > 0) {
    diagnostics.push({
      code: "JEV_UNSUPPORTED_IMAGE_FORMAT_OR_URL",
      severity: "warning",
      message: `Detected non-PNG/JPEG inline image URL(s) (${invalidImageUrls[0]}...). Jev accepts only base64 'image/png' or 'image/jpeg' (not webp or remote http URLs).`,
      recommendation: "Convert images to baseline PNG or JPEG (280-1568px, rotated upright) and send as data:image/jpeg;base64,... or asset references.",
    });
  }

  // 4. Context rot & long-context warnings (docs.typesafe.ai/model-jaggedness & models)
  if (stateUtf8Bytes > 32_000 && !input.longContext) {
    diagnostics.push({
      code: "LARGE_STATE_CONTEXT_ROT",
      severity: "warning",
      message: `State is ${(stateUtf8Bytes / 1024).toFixed(1)} KB; large states with unrelated fields suffer context rot or risk exceeding default limits.`,
      recommendation:
        "Filter irrelevant fields in code first, or screen/chunk with Noul before sending full records (enable longContext only when genuinely needed).",
    });
  }

  // 5. Speculative fan-out tip
  if (questionEntries.length === 1 && stateUtf8Bytes > 256) {
    diagnostics.push({
      code: "SINGLE_QUESTION_FANOUT_TIP",
      severity: "tip",
      message: "Only 1 question sent for this state.",
      recommendation:
        "Jev evaluates all questions on a shared state in parallel for 1 state pass; bundle related or speculative Noul/Choice/Score questions together.",
    });
  }

  // 6. Per-question inspection
  for (const [id, question] of questionEntries) {
    const instrText = stringifyTextForHeuristics(question.instructions);

    if (COUNTING_PATTERN.test(instrText)) {
      diagnostics.push({
        code: "JAGGED_COUNTING",
        severity: "warning",
        questionId: id,
        message: "Question appears to ask Jev to count items/occurrences.",
        recommendation:
          "From TypeSafe Model Jaggedness: Jev does not count reliably. Iterate over items in code with one Noul per item and sum in code, or use regex.",
      });
    }

    if (DATE_MATH_PATTERN.test(instrText)) {
      diagnostics.push({
        code: "JAGGED_MATH_OR_DATE_COMPARISON",
        severity: "warning",
        questionId: id,
        message: "Question appears to require date ordering, elapsed duration, or arithmetic.",
        recommendation:
          "From TypeSafe Model Jaggedness: extract bounded components in Jev or read structured fields and perform all math/date comparisons in deterministic code.",
      });
    }

    if (question.type === "noul") {
      if (DEGREE_WORD_PATTERN.test(instrText)) {
        diagnostics.push({
          code: "NOUL_MEASURING_DEGREE",
          severity: "warning",
          questionId: id,
          message: "Noul phrasing asks about a degree/intensity rather than a binary proposition.",
          recommendation:
            "A Noul returns probability of yes, not degree. Use a 'score' question with ordered concrete levels, or make the yes/no condition crisp.",
        });
      }
      if (NEGATED_NOUL_PATTERN.test(instrText)) {
        diagnostics.push({
          code: "NOUL_INVERTED_POLARITY",
          severity: "warning",
          questionId: id,
          message: "Noul appears negatively phrased (inverted meaning).",
          recommendation:
            "Phrase Noul positively so high values (>=0.7) mean presence/true, avoiding double-negative mistakes.",
        });
      }
      if (COMPOUND_CONDITION_PATTERN.test(instrText)) {
        diagnostics.push({
          code: "NOUL_COMPOUND_JUDGMENT",
          severity: "warning",
          questionId: id,
          message: "Noul appears to combine multiple conditions into one question.",
          recommendation:
            "Split compound checks into separate parallel Noul questions and combine them via explicit code boolean logic.",
        });
      }
    }

    if (question.type === "choice") {
      const optionKeys = Object.keys(question.criteria);
      if (optionKeys.length === 0) {
        diagnostics.push({
          code: "CHOICE_EMPTY_CRITERIA",
          severity: "error",
          questionId: id,
          message: "Choice question has zero options in criteria.",
          recommendation: "Provide at least 2 distinct options (max 255).",
        });
      } else if (optionKeys.length > 255) {
        diagnostics.push({
          code: "CHOICE_TOO_MANY_OPTIONS",
          severity: "error",
          questionId: id,
          message: `Choice question has ${optionKeys.length} options, exceeding the 255-option limit.`,
          recommendation: "Use a two-stage shortlist or hierarchical Choice tree.",
        });
      }

      const catchAllKey = optionKeys.find((k) =>
        /^(other|none|none_of_the_above|unknown|outro|nenhum)$/i.test(k.trim()),
      );
      if (catchAllKey) {
        diagnostics.push({
          code: "CHOICE_CATCHALL_VS_COMPANION_NOUL",
          severity: "tip",
          questionId: id,
          message: `Choice uses catch-all option '${catchAllKey}'.`,
          recommendation:
            "TypeSafe Companion Noul pattern: catch-all options compete with real labels and dilute probability. Add a companion 'noul' checking whether any real option fits.",
        });
      }

      const plainCount = optionKeys.filter((k) => typeof question.criteria[k] === "string" || question.criteria[k] === null).length;
      if (optionKeys.length >= 6 && plainCount === optionKeys.length) {
        diagnostics.push({
          code: "CHOICE_CONSIDER_STRUCTURED_CRITERIA",
          severity: "tip",
          questionId: id,
          message: `Choice has ${optionKeys.length} flat options.`,
          recommendation:
            "If similar options confuse Jev, use structured objects with {what, not_for, examples} to draw sharp contrastive boundaries.",
        });
      }
    }

    if (question.type === "score") {
      const levels = question.criteria;
      if (levels.length < 2 || levels.length > 10) {
        diagnostics.push({
          code: "SCORE_INVALID_LEVEL_COUNT",
          severity: "error",
          questionId: id,
          message: `Score must have 2-10 ordered levels (got ${levels.length}).`,
          recommendation: "Provide 2 to 10 distinct concrete descriptions ordered from low to high.",
        });
      }
      const numericOnly = levels.every((lvl) =>
        typeof lvl === "string" && /^\d+$/.test(lvl.trim()),
      );
      if (numericOnly) {
        diagnostics.push({
          code: "SCORE_BARE_NUMERIC_LEVELS",
          severity: "warning",
          questionId: id,
          message: "Score levels are bare numbers without descriptions.",
          recommendation:
            "TypeSafe Score docs: bare numbers perform poorly because each level is judged independently. Describe concrete situations for every level.",
        });
      }
    }

    if (question.type === "box") {
      const hasCompanionNoul = questionEntries.some(([nid, nq]) => {
        if (nq.type !== "noul") return false;
        const nInstr = stringifyTextForHeuristics(nq.instructions).toLowerCase();
        return (
          nid.includes(id) ||
          id.includes(nid) ||
          /(present|visible|exists|found|there|shown)/i.test(nid) ||
          /(present|visible|exists|in the image|in this image|in this photo|shown)/i.test(nInstr)
        );
      });
      if (!hasCompanionNoul) {
        diagnostics.push({
          code: "BOX_MISSING_COMPANION_NOUL",
          severity: "warning",
          questionId: id,
          message: "Box question has no companion Noul checking target existence in the same request.",
          recommendation:
            "A Box always returns coordinates even when the target is absent. Pair every Box with a Noul asking whether the target exists in the image.",
        });
      }
    }
  }

  // 7. Untrusted user text / prompt injection check
  const stateKeysStr =
    input.state && typeof input.state === "object" && !Array.isArray(input.state)
      ? Object.keys(input.state as Record<string, unknown>).join(" ")
      : "";
  const hasPolicyOrUntrustedData =
    UNTRUSTED_STATE_KEYS.test(stateKeysStr) &&
    stringifyTextForHeuristics(input.state).toLowerCase().includes("policy");
  const instrCombined = stringifyTextForHeuristics(input.questions).toLowerCase();
  if (
    hasPolicyOrUntrustedData &&
    !instrCombined.includes("part of the situation") &&
    !instrCombined.includes("never as") &&
    !instrCombined.includes("data only")
  ) {
    diagnostics.push({
      code: "PROMPT_INJECTION_DEFENSE_MISSING",
      severity: "tip",
      message: "State combines user message fields with policy text without an explicit data-only guardrail.",
      recommendation:
        "From TypeSafe Adversarial Content & OpenRouter Gate cookbook: clarify in instructions that user/customer text is data to judge, never instructions overriding policy.",
    });
  }

  void questionIds;

  // Score calculation: 100 minus penalties
  let score = 100;
  for (const d of diagnostics) {
    if (d.severity === "error") score -= 30;
    else if (d.severity === "warning") score -= 12;
    else score -= 3;
  }
  score = Math.max(0, Math.min(100, score));

  const hasError = diagnostics.some((d) => d.severity === "error");
  const hasWarning = diagnostics.some((d) => d.severity === "warning");

  return {
    status: hasError ? "fail" : hasWarning ? "warn" : "pass",
    score,
    metrics: {
      questionCount: questionEntries.length,
      stateUtf8Bytes,
      maxJsonDepth: maxDepth,
      assetCount: assetEntries.length,
      hasImages,
      hasBoxQuestion,
    },
    diagnostics,
  };
}
