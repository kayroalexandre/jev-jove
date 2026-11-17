import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  computeChoiceCalibrationStats,
  computeNoulCalibrationStats,
  optimizeNoulRoutingBands,
} from "../tmp/tsc/calibration/metrics.js";
import {
  applyCalibratedProfileToAnswer,
  buildCalibrationProfileFromJudgments,
  deleteCalibrationProfile,
  listCalibrationProfiles,
  loadCalibrationProfile,
  retuneProfileOffline,
  saveCalibrationProfile,
} from "../tmp/tsc/calibration/store.js";
import {
  fitChoiceTemperature,
  fitNoulTemperature,
} from "../tmp/tsc/calibration/temperature.js";

test("Noul temperature scaling reduces ECE/NLL on systematically overconfident outputs", () => {
  // Construct 40 samples where predictions are sharper/overconfident relative to true labels
  const samples = [];
  for (let i = 0; i < 40; i++) {
    // Alternating groups so empirical calibration diverges cleanly at extreme probs
    const isPosBlock = i < 24;
    const predictedProb = isPosBlock ? 0.96 : 0.04;
    const label = isPosBlock ? i % 4 !== 0 : i % 5 === 0; // true rates 0.75 vs 0.20 -> overconfident!
    samples.push({ id: `n_${i}`, predictedProb, label });
  }

  const fit = fitNoulTemperature(samples);
  assert.ok(fit.fittedTemperature > 1.2, `Expected T > 1.2 for overconfident probs, got ${fit.fittedTemperature}`);
  assert.equal(fit.improved, true);
  assert.ok(fit.metricsAfter.nll < fit.metricsBefore.nll, "Temperature scaling must lower NLL");
  assert.ok(fit.metricsAfter.ece < fit.metricsBefore.ece, "Temperature scaling must lower ECE");

  const bands = optimizeNoulRoutingBands(fit.scaledSamples, {
    minApprovePrecision: 0.75,
    minBlockNpv: 0.75,
    falsePositiveCost: 5,
    falseNegativeCost: 5,
    reviewCost: 1,
  });
  assert.ok(bands.approveAt >= bands.blockAt);
  assert.ok(bands.automationCoverage > 0);
});

test("Choice calibration & temperature scaling computes confidence sweep & macroF1", () => {
  const samples = [
    { id: "c1", predictedChoice: "a", probabilities: { a: 0.92, b: 0.05, c: 0.03 }, label: "a" },
    { id: "c2", predictedChoice: "a", probabilities: { a: 0.9, b: 0.06, c: 0.04 }, label: "a" },
    { id: "c3", predictedChoice: "b", probabilities: { a: 0.05, b: 0.91, c: 0.04 }, label: "b" },
    { id: "c4", predictedChoice: "c", probabilities: { a: 0.04, b: 0.06, c: 0.9 }, label: "c" },
    // Lower confidence mistakes
    { id: "c5", predictedChoice: "a", probabilities: { a: 0.45, b: 0.4, c: 0.15 }, label: "b" },
    { id: "c6", predictedChoice: "b", probabilities: { a: 0.42, b: 0.48, c: 0.1 }, label: "a" },
  ];

  const stats = computeChoiceCalibrationStats(samples, 10, 0.95);
  assert.ok(
    stats.recommendedConfidenceMin >= 0.3,
    `Expected cutoff >= 0.3 filtering out low-conf mistakes, got ${stats.recommendedConfidenceMin}`,
  );
  const selectedPoint = stats.confidenceSweep.find(
    (p) => p.confidenceMin === stats.recommendedConfidenceMin,
  );
  assert.ok(selectedPoint && selectedPoint.accuracyOnAccepted >= 0.95);

  const fit = fitChoiceTemperature(samples);
  assert.ok(fit.metricsAfter.nll <= fit.metricsBefore.nll + 1e-6);
});

test("Calibration store handles strict label coercion, persistence, $0 offline retune & model mismatch warning", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "jev-cal-test-"));
  const prevPluginData = process.env.PLUGIN_DATA;
  process.env.PLUGIN_DATA = tmpDir;

  try {
    assert.throws(
      () =>
        buildCalibrationProfileFromJudgments({
          profileId: "bad-label",
          taskType: "noul",
          questionId: "q",
          question: { type: "noul", instructions: "Safe?" },
          pinnedModel: "typesafe/jev-1.14",
          rawJudgments: [
            { id: "1", state: "a", label: "maybe", answer: { type: "noul", noul: 0.9 } },
          ],
        }),
      /invalid Noul ground-truth label/,
    );

    const profile = buildCalibrationProfileFromJudgments({
      profileId: "gate-test",
      taskType: "noul",
      questionId: "is_safe",
      question: { type: "noul", instructions: "Is safe?" },
      pinnedModel: "typesafe/jev-1.14",
      rawJudgments: [
        { id: "1", state: "safe1", label: true, answer: { type: "noul", noul: 0.95 } },
        { id: "2", state: "safe2", label: "true", answer: { type: "noul", noul: 0.88 } },
        { id: "3", state: "mid", label: "false", answer: { type: "noul", noul: 0.55 } },
        // Notice string "false" MUST parse as false, not Boolean("false") === true!
        { id: "4", state: "bad1", label: "false", answer: { type: "noul", noul: 0.08 } },
        { id: "5", state: "bad2", label: false, answer: { type: "noul", noul: 0.12 } },
      ],
    });

    const statsAfter = profile.summaryAfter;
    assert.equal(statsAfter.positiveCount, 2, "Must count exactly 2 positives (boolean true & 'true'), treating 'false' as false");
    assert.equal(statsAfter.negativeCount, 3);

    saveCalibrationProfile(profile);
    const list = listCalibrationProfiles();
    assert.equal(list.length, 1);
    assert.equal(list[0].profileId, "gate-test");

    const loaded = loadCalibrationProfile("gate-test");
    assert.equal(loaded.pinnedModel, "typesafe/jev-1.14");

    // $0 offline retune with stricter SLA
    const retuned = retuneProfileOffline("gate-test", {
      routingConfig: {
        minApprovePrecision: 0.99,
        minBlockNpv: 0.99,
        falsePositiveCost: 20,
        reviewCost: 1,
      },
    });
    assert.ok(retuned.thresholds.approveAt >= 0.65);

    // Pinned model guard check
    const mismatched = applyCalibratedProfileToAnswer(
      retuned,
      { type: "noul", noul: 0.92 },
      "typesafe/jev-1.13",
    );
    assert.equal(mismatched.modelMatchesPinned, false);
    assert.ok(mismatched.modelWarning.includes("Re-calibrate"));

    const refusalApplied = applyCalibratedProfileToAnswer(
      retuned,
      { type: "refusal", reason: "policy" },
      "typesafe/jev-1.14",
    );
    assert.equal(refusalApplied.routeAction, "refusal");

    assert.equal(deleteCalibrationProfile("gate-test"), true);
    assert.equal(listCalibrationProfiles().length, 0);
  } finally {
    if (prevPluginData === undefined) delete process.env.PLUGIN_DATA;
    else process.env.PLUGIN_DATA = prevPluginData;
    rmSync(tmpDir, { recursive: true, force: true });
  }

  void computeNoulCalibrationStats;
});
