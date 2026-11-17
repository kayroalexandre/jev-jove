import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDataSubdir } from "../config/runtimeConfig.js";
import type { DecisionAnswer, DecisionQuestion } from "../types/decisions.js";
import { computeScoreStats, extractConfidence } from "../typesafe/confidence.js";
import {
  computeChoiceCalibrationStats,
  computeScoreCalibrationStats,
  optimizeNoulRoutingBands,
  type ChoiceJudgmentSample,
  type NoulJudgmentSample,
  type RoutingBandOptimizationOptions,
  type ScoreJudgmentSample,
} from "./metrics.js";
import {
  applyTemperatureToChoice,
  applyTemperatureToNoul,
  fitChoiceTemperature,
  fitNoulTemperature,
} from "./temperature.js";

export interface StoredJudgmentSample {
  id: string;
  state: unknown;
  label: unknown;
  answer: DecisionAnswer;
  costUsd?: number;
}

export interface CalibrationProfile {
  profileId: string;
  name: string;
  taskType: "noul" | "choice" | "score";
  questionId: string;
  question: DecisionQuestion;
  pinnedModel: string;
  temperature: number;
  thresholds: {
    approveAt?: number;
    blockAt?: number;
    yesAt?: number;
    confidenceMin?: number;
  };
  optimizationConfig: RoutingBandOptimizationOptions & {
    targetAccuracy?: number;
  };
  summaryBefore: Record<string, unknown>;
  summaryAfter: Record<string, unknown>;
  routingBands?: ReturnType<typeof optimizeNoulRoutingBands>;
  rawJudgments: StoredJudgmentSample[];
  consistencyReport?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function validateProfileId(profileId: string): string {
  const cleaned = profileId.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(cleaned)) {
    throw new Error(
      `Invalid calibration profileId '${profileId}'. Use 1-64 characters matching [a-zA-Z0-9._-].`,
    );
  }
  return cleaned;
}

function calibrationsDir(): string {
  const dir = ensureDataSubdir("calibrations");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function profilePath(profileId: string): string {
  const safeId = validateProfileId(profileId);
  return join(calibrationsDir(), `${safeId}.json`);
}

export function saveCalibrationProfile(profile: CalibrationProfile): CalibrationProfile {
  const safeId = validateProfileId(profile.profileId);
  const toSave: CalibrationProfile = { ...profile, profileId: safeId };
  writeFileSync(profilePath(safeId), JSON.stringify(toSave, null, 2) + "\n", "utf8");
  return toSave;
}

export function loadCalibrationProfile(profileId: string): CalibrationProfile {
  const file = profilePath(profileId);
  if (!existsSync(file)) {
    throw new Error(`Calibration profile '${profileId}' does not exist.`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as CalibrationProfile;
}

export function listCalibrationProfiles(): Array<{
  profileId: string;
  name: string;
  taskType: CalibrationProfile["taskType"];
  pinnedModel: string;
  sampleCount: number;
  temperature: number;
  thresholds: CalibrationProfile["thresholds"];
  updatedAt: string;
}> {
  const dir = calibrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  return files.map((file) => {
    const p = JSON.parse(readFileSync(join(dir, file), "utf8")) as CalibrationProfile;
    return {
      profileId: p.profileId,
      name: p.name,
      taskType: p.taskType,
      pinnedModel: p.pinnedModel,
      sampleCount: p.rawJudgments.length,
      temperature: p.temperature,
      thresholds: p.thresholds,
      updatedAt: p.updatedAt,
    };
  });
}

export function deleteCalibrationProfile(profileId: string): boolean {
  const file = profilePath(profileId);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

function coerceBooleanLabel(id: string, label: unknown): boolean {
  if (typeof label === "boolean") return label;
  if (label === 1 || label === "1" || label === "true" || label === "yes") return true;
  if (label === 0 || label === "0" || label === "false" || label === "no") return false;
  throw new Error(
    `Sample '${id}' has invalid Noul ground-truth label '${String(label)}'. Expected boolean true/false (or 1/0).`,
  );
}

export function buildCalibrationProfileFromJudgments(opts: {
  profileId: string;
  name?: string;
  taskType: "noul" | "choice" | "score";
  questionId: string;
  question: DecisionQuestion;
  pinnedModel: string;
  rawJudgments: StoredJudgmentSample[];
  fitTemperature?: boolean;
  routingConfig?: RoutingBandOptimizationOptions;
  targetAccuracy?: number;
  consistencyReport?: Record<string, unknown>;
  createdAt?: string;
}): CalibrationProfile {
  const now = new Date().toISOString();
  const safeId = validateProfileId(opts.profileId);
  const fitTemp = opts.fitTemperature !== false;

  if (opts.taskType === "noul") {
    const samples: NoulJudgmentSample[] = opts.rawJudgments.map((j) => {
      if (j.answer.type !== "noul") {
        throw new Error(`Expected Noul answer for sample '${j.id}', got '${j.answer.type}'.`);
      }
      return {
        id: j.id,
        predictedProb: j.answer.noul,
        label: coerceBooleanLabel(j.id, j.label),
        costUsd: j.costUsd,
      };
    });

    const tempFit = fitNoulTemperature(samples);
    const chosenT = fitTemp ? tempFit.appliedTemperature : 1.0;
    const activeSamples = fitTemp ? tempFit.scaledSamples : samples;
    const routingBands = optimizeNoulRoutingBands(activeSamples, opts.routingConfig);
    const summaryAfter = fitTemp ? tempFit.metricsAfter : tempFit.metricsBefore;

    return {
      profileId: safeId,
      name: opts.name || safeId,
      taskType: "noul",
      questionId: opts.questionId,
      question: opts.question,
      pinnedModel: opts.pinnedModel,
      temperature: chosenT,
      thresholds: {
        approveAt: routingBands.approveAt,
        blockAt: routingBands.blockAt,
        yesAt: summaryAfter.bestF1.threshold,
      },
      optimizationConfig: {
        ...opts.routingConfig,
      },
      summaryBefore: tempFit.metricsBefore as unknown as Record<string, unknown>,
      summaryAfter: summaryAfter as unknown as Record<string, unknown>,
      routingBands,
      rawJudgments: opts.rawJudgments,
      consistencyReport: opts.consistencyReport,
      createdAt: opts.createdAt ?? now,
      updatedAt: now,
    };
  }

  if (opts.taskType === "choice") {
    const targetAcc = opts.targetAccuracy ?? 0.9;
    const samples: ChoiceJudgmentSample[] = opts.rawJudgments.map((j) => {
      if (j.answer.type !== "choice") {
        throw new Error(`Expected Choice answer for sample '${j.id}', got '${j.answer.type}'.`);
      }
      if (typeof j.label !== "string" || j.label.trim().length === 0) {
        throw new Error(`Sample '${j.id}' requires a non-empty string option label for Choice.`);
      }
      return {
        id: j.id,
        predictedChoice: j.answer.choice,
        probabilities: j.answer.probabilities,
        label: j.label,
        costUsd: j.costUsd,
      };
    });

    const tempFit = fitChoiceTemperature(samples);
    const chosenT = fitTemp ? tempFit.appliedTemperature : 1.0;
    const activeStats = fitTemp
      ? computeChoiceCalibrationStats(tempFit.scaledSamples, 10, targetAcc)
      : tempFit.metricsBefore;

    return {
      profileId: safeId,
      name: opts.name || safeId,
      taskType: "choice",
      questionId: opts.questionId,
      question: opts.question,
      pinnedModel: opts.pinnedModel,
      temperature: chosenT,
      thresholds: {
        confidenceMin: activeStats.recommendedConfidenceMin,
      },
      optimizationConfig: {
        targetAccuracy: targetAcc,
      },
      summaryBefore: tempFit.metricsBefore as unknown as Record<string, unknown>,
      summaryAfter: activeStats as unknown as Record<string, unknown>,
      rawJudgments: opts.rawJudgments,
      consistencyReport: opts.consistencyReport,
      createdAt: opts.createdAt ?? now,
      updatedAt: now,
    };
  }

  // Score calibration
  const scoreSamples: ScoreJudgmentSample[] = opts.rawJudgments.map((j) => {
    if (j.answer.type !== "score") {
      throw new Error(`Expected Score answer for sample '${j.id}', got '${j.answer.type}'.`);
    }
    const numericLabel = Number(j.label);
    if (!Number.isFinite(numericLabel)) {
      throw new Error(`Sample '${j.id}' requires a finite numeric target label for Score.`);
    }
    const stats = computeScoreStats(j.answer.probabilities);
    return {
      id: j.id,
      predictedScore: j.answer.score,
      probabilities: j.answer.probabilities,
      confidence: extractConfidence(j.answer),
      isBimodal: stats.isBimodal,
      label: numericLabel,
      costUsd: j.costUsd,
    };
  });
  const scoreStats = computeScoreCalibrationStats(scoreSamples);

  return {
    profileId: safeId,
    name: opts.name || safeId,
    taskType: "score",
    questionId: opts.questionId,
    question: opts.question,
    pinnedModel: opts.pinnedModel,
    temperature: 1.0,
    thresholds: {
      confidenceMin: scoreStats.recommendedConfidenceMin,
    },
    optimizationConfig: {},
    summaryBefore: scoreStats as unknown as Record<string, unknown>,
    summaryAfter: scoreStats as unknown as Record<string, unknown>,
    rawJudgments: opts.rawJudgments,
    consistencyReport: opts.consistencyReport,
    createdAt: opts.createdAt ?? now,
    updatedAt: now,
  };
}

/**
 * Re-tune thresholds and temperature offline from stored rawJudgments ($0 API spend!).
 */
export function retuneProfileOffline(
  profileId: string,
  updates: {
    fitTemperature?: boolean;
    routingConfig?: RoutingBandOptimizationOptions;
    targetAccuracy?: number;
  },
): CalibrationProfile {
  const existing = loadCalibrationProfile(profileId);
  const rebuilt = buildCalibrationProfileFromJudgments({
    profileId: existing.profileId,
    name: existing.name,
    taskType: existing.taskType,
    questionId: existing.questionId,
    question: existing.question,
    pinnedModel: existing.pinnedModel,
    rawJudgments: existing.rawJudgments,
    fitTemperature: updates.fitTemperature,
    routingConfig: updates.routingConfig ?? existing.optimizationConfig,
    targetAccuracy: updates.targetAccuracy ?? existing.optimizationConfig.targetAccuracy,
    consistencyReport: existing.consistencyReport,
    createdAt: existing.createdAt,
  });
  return saveCalibrationProfile(rebuilt);
}

export function applyCalibratedProfileToAnswer(
  profile: CalibrationProfile,
  answer: DecisionAnswer,
  responseModel?: string,
): {
  modelMatchesPinned: boolean;
  modelWarning?: string;
  rawAnswer: DecisionAnswer;
  calibratedAnswer: DecisionAnswer;
  routeAction: "approve" | "review" | "block" | "accept" | "escalate" | "refusal";
  confidence: number;
} {
  const modelMatchesPinned = !responseModel || responseModel === profile.pinnedModel;
  const modelWarning = modelMatchesPinned
    ? undefined
    : `Model mismatch: profile '${profile.profileId}' was calibrated for '${profile.pinnedModel}', but response came from '${responseModel}'. Re-calibrate when changing model versions.`;

  if (answer.type === "refusal") {
    return {
      modelMatchesPinned,
      modelWarning,
      rawAnswer: answer,
      calibratedAnswer: answer,
      routeAction: "refusal",
      confidence: 0,
    };
  }

  if (profile.taskType === "noul" && answer.type === "noul") {
    const scaled = applyTemperatureToNoul(answer.noul, profile.temperature);
    const approveAt = profile.thresholds.approveAt ?? 0.9;
    const blockAt = profile.thresholds.blockAt ?? 0.1;
    const routeAction =
      scaled.probability >= approveAt
        ? "approve"
        : scaled.probability <= blockAt
          ? "block"
          : "review";
    return {
      modelMatchesPinned,
      modelWarning,
      rawAnswer: answer,
      calibratedAnswer: {
        type: "noul",
        noul: scaled.probability,
        confidence: scaled.confidence,
      },
      routeAction,
      confidence: scaled.confidence,
    };
  }

  if (profile.taskType === "choice" && answer.type === "choice") {
    const scaled = applyTemperatureToChoice(answer.probabilities, profile.temperature);
    const minConf = profile.thresholds.confidenceMin ?? 0.7;
    return {
      modelMatchesPinned,
      modelWarning,
      rawAnswer: answer,
      calibratedAnswer: {
        type: "choice",
        choice: scaled.choice,
        probabilities: scaled.probabilities,
        confidence: scaled.confidence,
      },
      routeAction: scaled.confidence >= minConf ? "accept" : "escalate",
      confidence: scaled.confidence,
    };
  }

  if (profile.taskType === "score" && answer.type === "score") {
    const stats = computeScoreStats(answer.probabilities);
    const conf = extractConfidence(answer);
    const minConf = profile.thresholds.confidenceMin ?? 0.7;
    return {
      modelMatchesPinned,
      modelWarning,
      rawAnswer: answer,
      calibratedAnswer: answer,
      routeAction: !stats.isBimodal && conf >= minConf ? "accept" : "escalate",
      confidence: conf,
    };
  }

  throw new Error(
    `Profile '${profile.profileId}' expects '${profile.taskType}' answers, received '${answer.type}'.`,
  );
}
