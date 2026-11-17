import { randomUUID } from "node:crypto";
import type { OpenRouterJevClient } from "../openrouter/client.js";
import type { DecisionAnswer, DecisionQuestion } from "../types/decisions.js";
import { extractConfidence } from "../typesafe/confidence.js";

export interface ConsistencyAuditOptions {
  model?: string;
  state: unknown;
  questionId: string;
  question: DecisionQuestion;
  repeats?: number;
  bypassCache?: boolean;
  shuffleChoiceOrder?: boolean;
  sessionId?: string;
}

export interface ConsistencyAuditResult {
  questionId: string;
  questionType: DecisionQuestion["type"];
  modelRequested: string;
  repeats: number;
  bypassCache: boolean;
  meanPairwiseProbDiff: number;
  maxPairwiseProbDiff: number;
  estimatedFlipRate: number;
  dominantVerdict: string;
  verdictAgreementRate: number;
  optionOrderBiasDetected: boolean;
  orderComparison?: Array<{
    orderName: string;
    winner: string;
    confidence: number;
    probabilities: Record<string, number>;
  }>;
  samples: Array<{
    runIndex: number;
    verdict: string;
    confidence: number;
    rawAnswer: DecisionAnswer;
    latencyMs: number;
    costUsd: number;
  }>;
  totalCostUsd: number;
}

function withConsistencyUid(state: unknown): unknown {
  const uid = randomUUID();
  if (typeof state === "string") {
    return `${state}\n\n[audit_uid:${uid}]`;
  }
  if (Array.isArray(state)) {
    return [...state, `[audit_uid:${uid}]`];
  }
  if (state && typeof state === "object") {
    return { ...(state as Record<string, unknown>), _consistency_uid: uid };
  }
  return { value: state, _consistency_uid: uid };
}

function summarizeVerdict(ans: DecisionAnswer): { verdict: string; vector: number[] } {
  switch (ans.type) {
    case "noul":
      return { verdict: ans.noul >= 0.5 ? "true" : "false", vector: [ans.noul, 1 - ans.noul] };
    case "choice": {
      const keys = Object.keys(ans.probabilities).sort();
      return {
        verdict: ans.choice,
        vector: keys.map((k) => ans.probabilities[k] ?? 0),
      };
    }
    case "score": {
      const keys = Object.keys(ans.probabilities).sort();
      return {
        verdict: String(Math.round(ans.score)),
        vector: keys.map((k) => ans.probabilities[k] ?? 0),
      };
    }
    case "box":
      return {
        verdict: `${ans.box.left.toFixed(2)},${ans.box.top.toFixed(2)}`,
        vector: [ans.box.top, ans.box.bottom, ans.box.left, ans.box.right],
      };
    case "refusal":
      return { verdict: "refusal", vector: [0] };
  }
}

function rotateArray<T>(items: T[], offset: number): T[] {
  const n = items.length;
  if (n === 0) return items;
  const k = ((offset % n) + n) % n;
  return [...items.slice(k), ...items.slice(0, k)];
}

/**
 * TypeSafe Self-Consistency & Choice Option-Order Bias Audit:
 * - Follows TypeSafe's `consistency_noul_cookbook` using throwaway `uid` in state to defeat caches.
 * - Measures pairwise probability divergence across repeated evaluations.
 * - For Choice questions, tests reversed/rotated option orders to catch position bias.
 */
export async function auditConsistency(
  client: OpenRouterJevClient,
  opts: ConsistencyAuditOptions,
): Promise<ConsistencyAuditResult> {
  const repeats = Math.max(2, Math.min(20, opts.repeats ?? 5));
  const bypassCache = opts.bypassCache !== false;
  const modelRequested = opts.model?.trim() || "typesafe/jev-1.14";

  const samples: ConsistencyAuditResult["samples"] = [];
  const vectors: number[][] = [];
  const verdicts: string[] = [];
  let totalCostUsd = 0;

  for (let i = 0; i < repeats; i++) {
    const stateForCall = bypassCache ? withConsistencyUid(opts.state) : opts.state;
    const res = await client.decide({
      model: modelRequested,
      state: stateForCall,
      questions: { [opts.questionId]: opts.question },
      sessionId: opts.sessionId,
      responseCache: bypassCache ? false : undefined,
      cacheClear: bypassCache ? true : undefined,
      failOnRefusal: false,
    });
    const ans = res.response.answers[opts.questionId]!;
    const { verdict, vector } = summarizeVerdict(ans);
    vectors.push(vector);
    verdicts.push(verdict);
    totalCostUsd += res.estimatedCostUsd;
    samples.push({
      runIndex: i,
      verdict,
      confidence: extractConfidence(ans),
      rawAnswer: ans,
      latencyMs: res.latencyMs,
      costUsd: res.estimatedCostUsd,
    });
  }

  let pairCount = 0;
  let diffSum = 0;
  let maxDiff = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const a = vectors[i]!;
      const b = vectors[j]!;
      const len = Math.max(a.length, b.length);
      let l1 = 0;
      for (let d = 0; d < len; d++) {
        l1 += Math.abs((a[d] ?? 0) - (b[d] ?? 0));
      }
      // L1 / 2 equals total variation distance in [0, 1] on probability simplex
      const tvDist = a.length > 1 ? l1 / 2 : l1;
      diffSum += tvDist;
      if (tvDist > maxDiff) maxDiff = tvDist;
      pairCount++;
    }
  }

  const verdictCounts = new Map<string, number>();
  for (const v of verdicts) {
    verdictCounts.set(v, (verdictCounts.get(v) ?? 0) + 1);
  }
  const sortedVerdicts = [...verdictCounts.entries()].sort((a, b) => b[1] - a[1]);
  const dominantVerdict = sortedVerdicts[0]?.[0] ?? "";
  const dominantCount = sortedVerdicts[0]?.[1] ?? 0;

  let optionOrderBiasDetected = false;
  let orderComparison: ConsistencyAuditResult["orderComparison"];

  if (
    opts.question.type === "choice" &&
    opts.shuffleChoiceOrder !== false &&
    Object.keys(opts.question.criteria).length >= 2
  ) {
    const entries = Object.entries(opts.question.criteria);
    const orders: Array<{ name: string; entries: Array<[string, unknown]> }> = [
      { name: "original", entries },
      { name: "reversed", entries: [...entries].reverse() },
    ];
    if (entries.length >= 3) {
      orders.push({
        name: "rotated",
        entries: rotateArray(entries, Math.floor(entries.length / 2)),
      });
    }

    orderComparison = [];
    const winners = new Set<string>();
    for (const ord of orders) {
      const reorderedCriteria = Object.fromEntries(ord.entries);
      const q = { ...opts.question, criteria: reorderedCriteria };
      const res = await client.decide({
        model: modelRequested,
        state: bypassCache ? withConsistencyUid(opts.state) : opts.state,
        questions: { [opts.questionId]: q },
        sessionId: opts.sessionId,
        responseCache: false,
        failOnRefusal: false,
      });
      totalCostUsd += res.estimatedCostUsd;
      const ans = res.response.answers[opts.questionId];
      if (ans && ans.type === "choice") {
        winners.add(ans.choice);
        orderComparison.push({
          orderName: ord.name,
          winner: ans.choice,
          confidence: extractConfidence(ans),
          probabilities: ans.probabilities,
        });
      }
    }
    optionOrderBiasDetected = winners.size > 1;
  }

  const meanDiff = pairCount > 0 ? diffSum / pairCount : 0;

  return {
    questionId: opts.questionId,
    questionType: opts.question.type,
    modelRequested,
    repeats,
    bypassCache,
    meanPairwiseProbDiff: Number(meanDiff.toFixed(4)),
    maxPairwiseProbDiff: Number(maxDiff.toFixed(4)),
    estimatedFlipRate: Number(meanDiff.toFixed(4)),
    dominantVerdict,
    verdictAgreementRate: Number((dominantCount / repeats).toFixed(4)),
    optionOrderBiasDetected,
    orderComparison,
    samples,
    totalCostUsd: Number(totalCostUsd.toFixed(8)),
  };
}
