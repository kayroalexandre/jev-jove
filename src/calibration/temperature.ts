import { computeChoiceConfidence, computeNoulConfidence } from "../typesafe/confidence.js";
import {
  computeChoiceCalibrationStats,
  computeNoulCalibrationStats,
  type ChoiceCalibrationStats,
  type ChoiceJudgmentSample,
  type NoulCalibrationStats,
  type NoulJudgmentSample,
} from "./metrics.js";

const PROB_CLAMP = 1e-6;
const LOGIT_EPS = 1e-9;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function applyTemperatureToNoul(probability: number, temperature: number): {
  probability: number;
  confidence: number;
} {
  const safeT = Math.max(0.05, temperature);
  const p = clamp(probability, PROB_CLAMP, 1 - PROB_CLAMP);
  const logit = Math.log(p / (1 - p));
  const scaled = 1 / (1 + Math.exp(-logit / safeT));
  return {
    probability: Number(scaled.toFixed(6)),
    confidence: computeNoulConfidence(scaled),
  };
}

export function applyTemperatureToChoice(
  probabilities: Record<string, number>,
  temperature: number,
): {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
} {
  const safeT = Math.max(0.05, temperature);
  const entries = Object.entries(probabilities);
  if (entries.length === 0) {
    return { choice: "", probabilities: {}, confidence: 0 };
  }

  const scaledLogits = entries.map(([k, p]) => [k, Math.log(Math.max(p, LOGIT_EPS)) / safeT] as const);
  const maxLogit = Math.max(...scaledLogits.map(([, l]) => l));
  const exps = scaledLogits.map(([k, l]) => [k, Math.exp(l - maxLogit)] as const);
  const sumExp = exps.reduce((sum, [, e]) => sum + e, 0);

  const outProbs: Record<string, number> = {};
  let bestKey = entries[0]![0];
  let bestVal = -1;
  for (const [k, e] of exps) {
    const val = Number((e / sumExp).toFixed(6));
    outProbs[k] = val;
    if (val > bestVal) {
      bestVal = val;
      bestKey = k;
    }
  }

  return {
    choice: bestKey,
    probabilities: outProbs,
    confidence: computeChoiceConfidence(outProbs),
  };
}

function goldenSectionMinimize(
  fn: (t: number) => number,
  low: number,
  high: number,
  iters = 35,
): { t: number; loss: number } {
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = low;
  let b = high;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let fc = fn(c);
  let fd = fn(d);

  for (let i = 0; i < iters; i++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - phi * (b - a);
      fc = fn(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + phi * (b - a);
      fd = fn(d);
    }
  }

  const t = (a + b) / 2;
  return { t, loss: fn(t) };
}

export interface TemperatureFitResult<TStats> {
  fittedTemperature: number;
  appliedTemperature: number;
  improved: boolean;
  metricsBefore: TStats;
  metricsAfter: TStats;
}

export function fitNoulTemperature(
  samples: NoulJudgmentSample[],
): TemperatureFitResult<NoulCalibrationStats> & { scaledSamples: NoulJudgmentSample[] } {
  if (samples.length === 0) {
    throw new Error("At least 1 sample is required to fit Noul temperature.");
  }

  const lossAt = (t: number): number => {
    let total = 0;
    for (const s of samples) {
      const scaled = clamp(applyTemperatureToNoul(s.predictedProb, t).probability, LOGIT_EPS, 1 - LOGIT_EPS);
      const y = s.label ? 1 : 0;
      total += -(y * Math.log(scaled) + (1 - y) * Math.log(1 - scaled));
    }
    return total / samples.length;
  };

  // Coarse grid across [0.1, 10.0] + golden-section refinement around minimum
  let bestGridT = 1.0;
  let bestGridLoss = lossAt(1.0);
  for (let i = 1; i <= 100; i++) {
    const t = Number((i * 0.1).toFixed(2));
    const l = lossAt(t);
    if (l < bestGridLoss) {
      bestGridLoss = l;
      bestGridT = t;
    }
  }

  const low = Math.max(0.1, bestGridT - 0.15);
  const high = Math.min(10.0, bestGridT + 0.15);
  const refined = goldenSectionMinimize(lossAt, low, high);
  const candidateT = Number(refined.t.toFixed(4));

  const lossRaw = lossAt(1.0);
  const improved = refined.loss + 1e-4 < lossRaw;
  const appliedTemperature = improved ? candidateT : 1.0;

  const scaledSamples: NoulJudgmentSample[] = samples.map((s) => ({
    ...s,
    predictedProb: applyTemperatureToNoul(s.predictedProb, appliedTemperature).probability,
  }));

  return {
    fittedTemperature: candidateT,
    appliedTemperature,
    improved,
    metricsBefore: computeNoulCalibrationStats(samples),
    metricsAfter: computeNoulCalibrationStats(scaledSamples),
    scaledSamples,
  };
}

export function fitChoiceTemperature(
  samples: ChoiceJudgmentSample[],
): TemperatureFitResult<ChoiceCalibrationStats> & { scaledSamples: ChoiceJudgmentSample[] } {
  if (samples.length === 0) {
    throw new Error("At least 1 sample is required to fit Choice temperature.");
  }

  const lossAt = (t: number): number => {
    let total = 0;
    for (const s of samples) {
      const scaled = applyTemperatureToChoice(s.probabilities, t);
      const pTrue = clamp(scaled.probabilities[s.label] ?? LOGIT_EPS, LOGIT_EPS, 1 - LOGIT_EPS);
      total += -Math.log(pTrue);
    }
    return total / samples.length;
  };

  let bestGridT = 1.0;
  let bestGridLoss = lossAt(1.0);
  for (let i = 1; i <= 100; i++) {
    const t = Number((i * 0.1).toFixed(2));
    const l = lossAt(t);
    if (l < bestGridLoss) {
      bestGridLoss = l;
      bestGridT = t;
    }
  }

  const low = Math.max(0.1, bestGridT - 0.15);
  const high = Math.min(10.0, bestGridT + 0.15);
  const refined = goldenSectionMinimize(lossAt, low, high);
  const candidateT = Number(refined.t.toFixed(4));

  const lossRaw = lossAt(1.0);
  const improved = refined.loss + 1e-4 < lossRaw;
  const appliedTemperature = improved ? candidateT : 1.0;

  const scaledSamples: ChoiceJudgmentSample[] = samples.map((s) => {
    const scaled = applyTemperatureToChoice(s.probabilities, appliedTemperature);
    return {
      ...s,
      predictedChoice: scaled.choice,
      probabilities: scaled.probabilities,
    };
  });

  return {
    fittedTemperature: candidateT,
    appliedTemperature,
    improved,
    metricsBefore: computeChoiceCalibrationStats(samples),
    metricsAfter: computeChoiceCalibrationStats(scaledSamples),
    scaledSamples,
  };
}
