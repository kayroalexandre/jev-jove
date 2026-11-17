import { computeChoiceConfidence, computeNoulConfidence } from "../typesafe/confidence.js";

const EPS = 1e-7;

export interface NoulJudgmentSample {
  id: string;
  predictedProb: number;
  label: boolean;
  costUsd?: number;
}

export interface ChoiceJudgmentSample {
  id: string;
  predictedChoice: string;
  probabilities: Record<string, number>;
  label: string;
  costUsd?: number;
}

export interface ScoreJudgmentSample {
  id: string;
  predictedScore: number;
  probabilities: Record<string, number>;
  confidence?: number;
  isBimodal?: boolean;
  label: number;
  costUsd?: number;
}

export interface BinaryThresholdPoint {
  threshold: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  specificity: number;
  f1: number;
  accuracy: number;
  positiveRate: number;
  sampleCount: number;
}

export interface ReliabilityBin {
  binIndex: number;
  binStart: number;
  binEnd: number;
  count: number;
  avgConfidenceOrProb: number;
  empiricalAccuracyOrRate: number;
  gap: number;
}

export interface ConfidenceBandStat {
  band: string;
  count: number;
  accuracyOrMatchRate: number;
  avgConfidence: number;
}

export interface NoulCalibrationStats {
  sampleCount: number;
  positiveCount: number;
  negativeCount: number;
  baseRate: number;
  ece: number;
  mce: number;
  brierScore: number;
  nll: number;
  bins: ReliabilityBin[];
  confidenceBands: ConfidenceBandStat[];
  thresholdSweep: BinaryThresholdPoint[];
  bestF1: BinaryThresholdPoint;
  bestAccuracy: BinaryThresholdPoint;
}

export interface RoutingBandOptimizationOptions {
  minApprovePrecision?: number;
  minBlockNpv?: number;
  maxReviewRate?: number;
  falsePositiveCost?: number;
  falseNegativeCost?: number;
  reviewCost?: number;
}

export interface RoutingBandResult {
  approveAt: number;
  blockAt: number;
  approvePrecision: number;
  blockNpv: number;
  autoApproveCount: number;
  autoBlockCount: number;
  reviewCount: number;
  autoApproveRate: number;
  autoBlockRate: number;
  reviewRate: number;
  automationCoverage: number;
  approveErrors: number;
  blockErrors: number;
  totalExpectedCost: number;
  slaSatisfied: boolean;
}

export interface ChoiceCalibrationStats {
  sampleCount: number;
  accuracy: number;
  macroF1: number;
  ece: number;
  mce: number;
  brierScore: number;
  nll: number;
  bins: ReliabilityBin[];
  confidenceBands: ConfidenceBandStat[];
  perClass: Record<
    string,
    {
      tp: number;
      fp: number;
      fn: number;
      precision: number;
      recall: number;
      f1: number;
      support: number;
    }
  >;
  confidenceSweep: Array<{
    confidenceMin: number;
    acceptedCount: number;
    abstainedCount: number;
    coverage: number;
    accuracyOnAccepted: number;
    errorRateOnAccepted: number;
  }>;
  recommendedConfidenceMin: number;
}

export interface ScoreCalibrationStats {
  sampleCount: number;
  mae: number;
  rmse: number;
  pearsonCorrelation: number;
  meanConfidence: number;
  bimodalCount: number;
  confidenceSweep: Array<{
    confidenceMin: number;
    acceptedCount: number;
    coverage: number;
    maeOnAccepted: number;
    rmseOnAccepted: number;
  }>;
  recommendedConfidenceMin: number;
}

function clampProb(p: number): number {
  return Math.max(EPS, Math.min(1 - EPS, p));
}

function round4(n: number): number {
  return Number(n.toFixed(4));
}

export function computeBinaryMetricsAtThreshold(
  samples: NoulJudgmentSample[],
  threshold: number,
): BinaryThresholdPoint {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;

  for (const s of samples) {
    const pred = s.predictedProb >= threshold;
    if (pred && s.label) tp++;
    else if (pred && !s.label) fp++;
    else if (!pred && !s.label) tn++;
    else fn++;
  }

  const n = samples.length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const specificity = tn + fp > 0 ? tn / (tn + fp) : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const accuracy = n > 0 ? (tp + tn) / n : 1;
  const positiveRate = n > 0 ? (tp + fp) / n : 0;

  return {
    threshold: Number(threshold.toFixed(3)),
    tp,
    fp,
    tn,
    fn,
    precision: round4(precision),
    recall: round4(recall),
    specificity: round4(specificity),
    f1: round4(f1),
    accuracy: round4(accuracy),
    positiveRate: round4(positiveRate),
    sampleCount: n,
  };
}

export function sweepNoulThresholds(
  samples: NoulJudgmentSample[],
  thresholds?: number[],
): {
  points: BinaryThresholdPoint[];
  bestF1: BinaryThresholdPoint;
  bestAccuracy: BinaryThresholdPoint;
} {
  const grid =
    thresholds ??
    Array.from({ length: 19 }, (_, idx) => Number(((idx + 1) * 0.05).toFixed(2)));
  const points = grid.map((t) => computeBinaryMetricsAtThreshold(samples, t));

  const bestF1 = [...points].sort((a, b) => {
    if (b.f1 !== a.f1) return b.f1 - a.f1;
    return Math.abs(a.threshold - 0.5) - Math.abs(b.threshold - 0.5);
  })[0]!;

  const bestAccuracy = [...points].sort((a, b) => {
    if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
    return b.f1 - a.f1;
  })[0]!;

  return { points, bestF1, bestAccuracy };
}

export function computeNoulCalibrationStats(
  samples: NoulJudgmentSample[],
  numBins = 10,
): NoulCalibrationStats {
  const n = samples.length;
  if (n === 0) {
    throw new Error("At least 1 sample is required to compute Noul calibration stats.");
  }

  let positiveCount = 0;
  let brierSum = 0;
  let nllSum = 0;

  const binSums = Array.from({ length: numBins }, () => ({
    count: 0,
    probSum: 0,
    posSum: 0,
  }));

  for (const s of samples) {
    const p = clampProb(s.predictedProb);
    const y = s.label ? 1 : 0;
    if (y === 1) positiveCount++;
    brierSum += (p - y) ** 2;
    nllSum += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));

    const rawIdx = Math.floor(s.predictedProb * numBins);
    const binIdx = Math.max(0, Math.min(numBins - 1, rawIdx));
    const bin = binSums[binIdx]!;
    bin.count++;
    bin.probSum += s.predictedProb;
    bin.posSum += y;
  }

  const bins: ReliabilityBin[] = [];
  let ece = 0;
  let mce = 0;
  for (let i = 0; i < numBins; i++) {
    const b = binSums[i]!;
    const binStart = Number((i / numBins).toFixed(2));
    const binEnd = Number(((i + 1) / numBins).toFixed(2));
    if (b.count === 0) {
      bins.push({
        binIndex: i,
        binStart,
        binEnd,
        count: 0,
        avgConfidenceOrProb: 0,
        empiricalAccuracyOrRate: 0,
        gap: 0,
      });
      continue;
    }
    const avgP = b.probSum / b.count;
    const empRate = b.posSum / b.count;
    const gap = Math.abs(empRate - avgP);
    ece += (b.count / n) * gap;
    if (gap > mce) mce = gap;
    bins.push({
      binIndex: i,
      binStart,
      binEnd,
      count: b.count,
      avgConfidenceOrProb: round4(avgP),
      empiricalAccuracyOrRate: round4(empRate),
      gap: round4(gap),
    });
  }

  // TypeSafe confidence bands: <0.5, 0.5-0.8, >=0.8 (comparing binary prediction match vs confidence)
  const bandDefs = [
    { name: "<0.5 (low)", min: 0, max: 0.5 },
    { name: "0.5-0.8 (moderate)", min: 0.5, max: 0.8 },
    { name: ">=0.8 (high)", min: 0.8, max: 1.0001 },
  ];
  const confidenceBands: ConfidenceBandStat[] = bandDefs.map((bd) => {
    const bucket = samples.filter((s) => {
      const c = computeNoulConfidence(s.predictedProb);
      return c >= bd.min && c < bd.max;
    });
    if (bucket.length === 0) {
      return { band: bd.name, count: 0, accuracyOrMatchRate: 0, avgConfidence: 0 };
    }
    let correct = 0;
    let confSum = 0;
    for (const s of bucket) {
      const pred = s.predictedProb >= 0.5;
      if (pred === s.label) correct++;
      confSum += computeNoulConfidence(s.predictedProb);
    }
    return {
      band: bd.name,
      count: bucket.length,
      accuracyOrMatchRate: round4(correct / bucket.length),
      avgConfidence: round4(confSum / bucket.length),
    };
  });

  const { points, bestF1, bestAccuracy } = sweepNoulThresholds(samples);

  return {
    sampleCount: n,
    positiveCount,
    negativeCount: n - positiveCount,
    baseRate: round4(positiveCount / n),
    ece: round4(ece),
    mce: round4(mce),
    brierScore: round4(brierSum / n),
    nll: round4(nllSum / n),
    bins,
    confidenceBands,
    thresholdSweep: points,
    bestF1,
    bestAccuracy,
  };
}

export function optimizeNoulRoutingBands(
  samples: NoulJudgmentSample[],
  opts?: RoutingBandOptimizationOptions,
): RoutingBandResult {
  const n = samples.length;
  if (n === 0) {
    throw new Error("At least 1 sample is required to optimize routing bands.");
  }

  const minApprovePrecision = opts?.minApprovePrecision ?? 0.9;
  const minBlockNpv = opts?.minBlockNpv ?? 0.9;
  const maxReviewRate = opts?.maxReviewRate ?? 1.0;
  const fpCost = opts?.falsePositiveCost ?? 10;
  const fnCost = opts?.falseNegativeCost ?? 10;
  const reviewCost = opts?.reviewCost ?? 1;

  const blockCandidates = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5];
  const approveCandidates = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];

  const evaluatePair = (blockAt: number, approveAt: number, slaSatisfied: boolean): RoutingBandResult => {
    let autoApproveCount = 0;
    let approveErrors = 0;
    let autoBlockCount = 0;
    let blockErrors = 0;
    let reviewCount = 0;

    for (const s of samples) {
      if (s.predictedProb >= approveAt) {
        autoApproveCount++;
        if (!s.label) approveErrors++;
      } else if (s.predictedProb <= blockAt) {
        autoBlockCount++;
        if (s.label) blockErrors++;
      } else {
        reviewCount++;
      }
    }

    const approvePrecision =
      autoApproveCount > 0 ? (autoApproveCount - approveErrors) / autoApproveCount : 1;
    const blockNpv =
      autoBlockCount > 0 ? (autoBlockCount - blockErrors) / autoBlockCount : 1;
    const reviewRate = reviewCount / n;
    const totalExpectedCost = approveErrors * fpCost + blockErrors * fnCost + reviewCount * reviewCost;

    return {
      approveAt,
      blockAt,
      approvePrecision: round4(approvePrecision),
      blockNpv: round4(blockNpv),
      autoApproveCount,
      autoBlockCount,
      reviewCount,
      autoApproveRate: round4(autoApproveCount / n),
      autoBlockRate: round4(autoBlockCount / n),
      reviewRate: round4(reviewRate),
      automationCoverage: round4((autoApproveCount + autoBlockCount) / n),
      approveErrors,
      blockErrors,
      totalExpectedCost: round4(totalExpectedCost),
      slaSatisfied,
    };
  };

  const isBetterCandidate = (cand: RoutingBandResult, best: RoutingBandResult | null): boolean => {
    if (!best) return true;
    if (cand.totalExpectedCost !== best.totalExpectedCost) {
      return cand.totalExpectedCost < best.totalExpectedCost;
    }
    if (cand.automationCoverage !== best.automationCoverage) {
      return cand.automationCoverage > best.automationCoverage;
    }
    // Maximize separation margin (approveAt - blockAt) when cost and coverage tie
    const candMargin = cand.approveAt - cand.blockAt;
    const bestMargin = best.approveAt - best.blockAt;
    return candMargin > bestMargin;
  };

  let bestFeasible: RoutingBandResult | null = null;
  let bestFallback: RoutingBandResult | null = null;

  for (const blockAt of blockCandidates) {
    for (const approveAt of approveCandidates) {
      if (blockAt > approveAt) continue;
      // If blockAt === approveAt (both 0.5), review is empty and approve wins ties
      const candidate = evaluatePair(blockAt, approveAt, false);
      const meetsSla =
        candidate.approvePrecision >= minApprovePrecision &&
        candidate.blockNpv >= minBlockNpv &&
        candidate.reviewRate <= maxReviewRate &&
        candidate.automationCoverage > 0;

      if (meetsSla) {
        const feasible: RoutingBandResult = { ...candidate, slaSatisfied: true };
        if (isBetterCandidate(feasible, bestFeasible)) {
          bestFeasible = feasible;
        }
      }

      if (isBetterCandidate(candidate, bestFallback)) {
        bestFallback = candidate;
      }
    }
  }

  return bestFeasible ?? bestFallback!;
}

export function computeChoiceCalibrationStats(
  samples: ChoiceJudgmentSample[],
  numBins = 10,
  targetAccuracy = 0.9,
): ChoiceCalibrationStats {
  const n = samples.length;
  if (n === 0) {
    throw new Error("At least 1 sample is required to compute Choice calibration stats.");
  }

  let correct = 0;
  let brierSum = 0;
  let nllSum = 0;
  const labelsSet = new Set<string>();
  const binSums = Array.from({ length: numBins }, () => ({
    count: 0,
    topProbSum: 0,
    correctSum: 0,
  }));

  for (const s of samples) {
    labelsSet.add(s.label);
    labelsSet.add(s.predictedChoice);
    for (const k of Object.keys(s.probabilities)) labelsSet.add(k);

    const isRight = s.predictedChoice === s.label;
    if (isRight) correct++;

    const pTrue = clampProb(s.probabilities[s.label] ?? 0);
    nllSum += -Math.log(pTrue);

    const pVals = Object.values(s.probabilities);
    const pMax = pVals.length > 0 ? Math.max(...pVals) : 0;

    let sampleBrier = 0;
    const allKeys = new Set([...Object.keys(s.probabilities), s.label]);
    for (const k of allKeys) {
      const pk = s.probabilities[k] ?? 0;
      const yk = k === s.label ? 1 : 0;
      sampleBrier += (pk - yk) ** 2;
    }
    brierSum += sampleBrier;

    const rawIdx = Math.floor(pMax * numBins);
    const binIdx = Math.max(0, Math.min(numBins - 1, rawIdx));
    const bin = binSums[binIdx]!;
    bin.count++;
    bin.topProbSum += pMax;
    bin.correctSum += isRight ? 1 : 0;
  }

  const bins: ReliabilityBin[] = [];
  let ece = 0;
  let mce = 0;
  for (let i = 0; i < numBins; i++) {
    const b = binSums[i]!;
    const binStart = Number((i / numBins).toFixed(2));
    const binEnd = Number(((i + 1) / numBins).toFixed(2));
    if (b.count === 0) {
      bins.push({
        binIndex: i,
        binStart,
        binEnd,
        count: 0,
        avgConfidenceOrProb: 0,
        empiricalAccuracyOrRate: 0,
        gap: 0,
      });
      continue;
    }
    const avgP = b.topProbSum / b.count;
    const empAcc = b.correctSum / b.count;
    const gap = Math.abs(empAcc - avgP);
    ece += (b.count / n) * gap;
    if (gap > mce) mce = gap;
    bins.push({
      binIndex: i,
      binStart,
      binEnd,
      count: b.count,
      avgConfidenceOrProb: round4(avgP),
      empiricalAccuracyOrRate: round4(empAcc),
      gap: round4(gap),
    });
  }

  const bandDefs = [
    { name: "<0.5 (low)", min: 0, max: 0.5 },
    { name: "0.5-0.8 (moderate)", min: 0.5, max: 0.8 },
    { name: ">=0.8 (high)", min: 0.8, max: 1.0001 },
  ];
  const confidenceBands: ConfidenceBandStat[] = bandDefs.map((bd) => {
    const bucket = samples.filter((s) => {
      const c = computeChoiceConfidence(s.probabilities);
      return c >= bd.min && c < bd.max;
    });
    if (bucket.length === 0) {
      return { band: bd.name, count: 0, accuracyOrMatchRate: 0, avgConfidence: 0 };
    }
    let matches = 0;
    let confSum = 0;
    for (const s of bucket) {
      if (s.predictedChoice === s.label) matches++;
      confSum += computeChoiceConfidence(s.probabilities);
    }
    return {
      band: bd.name,
      count: bucket.length,
      accuracyOrMatchRate: round4(matches / bucket.length),
      avgConfidence: round4(confSum / bucket.length),
    };
  });

  const perClass: ChoiceCalibrationStats["perClass"] = {};
  const labelF1s: number[] = [];
  for (const cls of [...labelsSet].sort()) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let support = 0;
    for (const s of samples) {
      if (s.label === cls) support++;
      if (s.predictedChoice === cls && s.label === cls) tp++;
      else if (s.predictedChoice === cls && s.label !== cls) fp++;
      else if (s.predictedChoice !== cls && s.label === cls) fn++;
    }
    if (support === 0 && fp === 0) continue;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    perClass[cls] = {
      tp,
      fp,
      fn,
      precision: round4(precision),
      recall: round4(recall),
      f1: round4(f1),
      support,
    };
    if (support > 0) labelF1s.push(f1);
  }

  const cutoffs = [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];
  const confidenceSweep = cutoffs.map((cMin) => {
    const accepted = samples.filter((s) => computeChoiceConfidence(s.probabilities) >= cMin);
    const acceptedCount = accepted.length;
    const abstainedCount = n - acceptedCount;
    const acceptedCorrect = accepted.filter((s) => s.predictedChoice === s.label).length;
    const acc = acceptedCount > 0 ? acceptedCorrect / acceptedCount : 1;
    return {
      confidenceMin: cMin,
      acceptedCount,
      abstainedCount,
      coverage: round4(acceptedCount / n),
      accuracyOnAccepted: round4(acc),
      errorRateOnAccepted: round4(1 - acc),
    };
  });

  // Lowest confidence threshold that satisfies targetAccuracy with non-zero coverage
  const passing = confidenceSweep
    .filter((pt) => pt.acceptedCount > 0 && pt.accuracyOnAccepted >= targetAccuracy)
    .sort((a, b) => b.coverage - a.coverage || a.confidenceMin - b.confidenceMin);
  const recommendedConfidenceMin = passing[0]?.confidenceMin ?? 0.7;

  const macroF1 =
    labelF1s.length > 0 ? labelF1s.reduce((a, b) => a + b, 0) / labelF1s.length : 0;

  return {
    sampleCount: n,
    accuracy: round4(correct / n),
    macroF1: round4(macroF1),
    ece: round4(ece),
    mce: round4(mce),
    brierScore: round4(brierSum / n),
    nll: round4(nllSum / n),
    bins,
    confidenceBands,
    perClass,
    confidenceSweep,
    recommendedConfidenceMin,
  };
}

export function computeScoreCalibrationStats(
  samples: ScoreJudgmentSample[],
): ScoreCalibrationStats {
  const n = samples.length;
  if (n === 0) {
    throw new Error("At least 1 sample is required to compute Score calibration stats.");
  }

  let absErr = 0;
  let sqErr = 0;
  let confSum = 0;
  let bimodalCount = 0;

  for (const s of samples) {
    const diff = s.predictedScore - s.label;
    absErr += Math.abs(diff);
    sqErr += diff * diff;
    confSum += s.confidence ?? 0;
    if (s.isBimodal) bimodalCount++;
  }

  const meanX = samples.reduce((a, b) => a + b.predictedScore, 0) / n;
  const meanY = samples.reduce((a, b) => a + b.label, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (const s of samples) {
    const dx = s.predictedScore - meanX;
    const dy = s.label - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const pearson = denX > 0 && denY > 0 ? num / Math.sqrt(denX * denY) : 0;

  const cutoffs = [0, 0.3, 0.5, 0.6, 0.7, 0.8, 0.9];
  const confidenceSweep = cutoffs.map((cMin) => {
    const accepted = samples.filter((s) => (s.confidence ?? 0) >= cMin);
    if (accepted.length === 0) {
      return {
        confidenceMin: cMin,
        acceptedCount: 0,
        coverage: 0,
        maeOnAccepted: 0,
        rmseOnAccepted: 0,
      };
    }
    const maeAcc =
      accepted.reduce((sum, s) => sum + Math.abs(s.predictedScore - s.label), 0) / accepted.length;
    const rmseAcc = Math.sqrt(
      accepted.reduce((sum, s) => sum + (s.predictedScore - s.label) ** 2, 0) / accepted.length,
    );
    return {
      confidenceMin: cMin,
      acceptedCount: accepted.length,
      coverage: round4(accepted.length / n),
      maeOnAccepted: round4(maeAcc),
      rmseOnAccepted: round4(rmseAcc),
    };
  });

  const nonBimodalPoint = confidenceSweep.find((pt) => pt.confidenceMin >= 0.7 && pt.acceptedCount > 0);
  return {
    sampleCount: n,
    mae: round4(absErr / n),
    rmse: round4(Math.sqrt(sqErr / n)),
    pearsonCorrelation: round4(pearson),
    meanConfidence: round4(confSum / n),
    bimodalCount,
    confidenceSweep,
    recommendedConfidenceMin: nonBimodalPoint ? 0.7 : 0.5,
  };
}
