import type {
  ChoiceAnswer,
  DecisionAnswer,
  NoulAnswer,
  ScoreAnswer,
} from "../types/decisions.js";

/**
 * TypeSafe Noul certainty: distance from 0.5 normalized onto [0, 1].
 * p = 0.5 -> 0.0; p = 0.0 or 1.0 -> 1.0.
 */
export function computeNoulConfidence(p: number): number {
  const clamped = Math.max(0, Math.min(1, p));
  return Number(Math.abs(2 * clamped - 1).toFixed(6));
}

/**
 * TypeSafe Choice confidence: excess probability over uniform 1/N normalized to [0, 1].
 * Matches official docs examples:
 * - {0.61, 0.35, 0.04} (N=3) -> (0.61 - 1/3) / (2/3) = 0.415 (~0.42)
 * - {0.40, 0.34, 0.24, 0.02} (N=4) -> (0.40 - 0.25) / 0.75 = 0.20
 */
export function computeChoiceConfidence(probabilities: Record<string, number>): number {
  const vals = Object.values(probabilities);
  const n = vals.length;
  if (n <= 1) return 1;
  const pMax = Math.max(...vals);
  const raw = (pMax - 1 / n) / (1 - 1 / n);
  return Number(Math.max(0, Math.min(1, raw)).toFixed(6));
}

/**
 * Compute weighted expected score, spread/stdDev, normalized score [0, 1],
 * and concentration-based fallback confidence when the endpoint omits confidence.
 */
export function computeScoreStats(probabilities: Record<string, number>): {
  expectedScore: number;
  levelCount: number;
  stdDev: number;
  fallbackConfidence: number;
  isBimodal: boolean;
  topTwoLevels: Array<{ level: number; probability: number }>;
} {
  const entries = Object.entries(probabilities)
    .map(([k, p]) => ({ level: Number(k), probability: p }))
    .filter((item) => Number.isFinite(item.level))
    .sort((a, b) => a.level - b.level);

  const n = entries.length;
  if (n === 0) {
    return {
      expectedScore: 0,
      levelCount: 0,
      stdDev: 0,
      fallbackConfidence: 0,
      isBimodal: false,
      topTwoLevels: [],
    };
  }

  let mean = 0;
  for (const e of entries) {
    mean += e.level * e.probability;
  }

  let variance = 0;
  for (const e of entries) {
    variance += e.probability * (e.level - mean) ** 2;
  }
  const stdDev = Math.sqrt(Math.max(0, variance));

  // Uniform discrete variance over 0..(n-1) is (n^2 - 1) / 12
  const maxUniformVariance = n > 1 ? (n * n - 1) / 12 : 1;
  const fallbackConfidence =
    n <= 1 ? 1 : Number(Math.max(0, Math.min(1, 1 - variance / maxUniformVariance)).toFixed(6));

  const sortedByProb = [...entries].sort((a, b) => b.probability - a.probability);
  const top1 = sortedByProb[0];
  const top2 = sortedByProb[1];
  // Bimodal heuristic from TypeSafe docs: high probability mass split across non-adjacent levels
  const isBimodal = Boolean(
    top1 &&
      top2 &&
      top1.probability >= 0.25 &&
      top2.probability >= 0.25 &&
      Math.abs(top1.level - top2.level) >= 2,
  );

  return {
    expectedScore: mean,
    levelCount: n,
    stdDev,
    fallbackConfidence,
    isBimodal,
    topTwoLevels: sortedByProb.slice(0, 2),
  };
}

export function extractConfidence(answer: DecisionAnswer): number {
  switch (answer.type) {
    case "noul":
      return answer.confidence ?? computeNoulConfidence(answer.noul);
    case "choice":
      return answer.confidence ?? computeChoiceConfidence(answer.probabilities);
    case "score":
      return answer.confidence ?? computeScoreStats(answer.probabilities).fallbackConfidence;
    case "box":
      return answer.confidence ?? 0;
    case "refusal":
      return 0;
  }
}

export function analyzeChoiceRunnerUp(
  answer: ChoiceAnswer,
  secondaryThreshold = 0.25,
): {
  winner: string;
  winnerProbability: number;
  confidence: number;
  secondaryOptions: Array<{ option: string; probability: number }>;
} {
  const confidence = extractConfidence(answer);
  const winnerProbability = answer.probabilities[answer.choice] ?? 0;
  const secondaryOptions = Object.entries(answer.probabilities)
    .filter(([opt, prob]) => opt !== answer.choice && prob > secondaryThreshold)
    .sort(([, a], [, b]) => b - a)
    .map(([option, probability]) => ({ option, probability }));

  return {
    winner: answer.choice,
    winnerProbability,
    confidence,
    secondaryOptions,
  };
}

export function normalizeScoreValue(answer: ScoreAnswer): number {
  const levels = Object.keys(answer.probabilities)
    .map(Number)
    .filter((v) => Number.isFinite(v));
  const minLevel = levels.length > 0 ? Math.min(...levels) : 0;
  const maxLevel = levels.length > 0 ? Math.max(...levels) : 1;
  const span = maxLevel - minLevel;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, (answer.score - minLevel) / span));
}

export function interpretNoulBand(
  answer: NoulAnswer,
  yesAt = 0.7,
  noAt = 0.3,
): {
  verdict: "yes" | "no" | "uncertain";
  probability: number;
  confidence: number;
} {
  const confidence = extractConfidence(answer);
  if (answer.noul >= yesAt) {
    return { verdict: "yes", probability: answer.noul, confidence };
  }
  if (answer.noul <= noAt) {
    return { verdict: "no", probability: answer.noul, confidence };
  }
  return { verdict: "uncertain", probability: answer.noul, confidence };
}
