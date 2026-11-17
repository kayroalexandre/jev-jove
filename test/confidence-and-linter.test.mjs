import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeChoiceRunnerUp,
  computeChoiceConfidence,
  computeNoulConfidence,
  computeScoreStats,
  interpretNoulBand,
  normalizeScoreValue,
} from "../tmp/tsc/typesafe/confidence.js";
import { lintDesign } from "../tmp/tsc/typesafe/linter.js";

test("computeNoulConfidence follows exact |2p - 1| formula", () => {
  assert.equal(computeNoulConfidence(0.5), 0);
  assert.equal(computeNoulConfidence(1.0), 1);
  assert.equal(computeNoulConfidence(0.0), 1);
  assert.equal(computeNoulConfidence(0.85), 0.7);
  assert.equal(computeNoulConfidence(0.15), 0.7);
});

test("computeChoiceConfidence matches TypeSafe official doc examples", () => {
  const ex1 = computeChoiceConfidence({ a: 0.61, b: 0.35, c: 0.04 });
  assert.ok(Math.abs(ex1 - 0.415) < 1e-4, `Expected ~0.415, got ${ex1}`);

  const ex2 = computeChoiceConfidence({ a: 0.4, b: 0.34, c: 0.24, d: 0.02 });
  assert.ok(Math.abs(ex2 - 0.2) < 1e-4, `Expected ~0.20, got ${ex2}`);

  assert.equal(computeChoiceConfidence({ a: 0.5, b: 0.5 }), 0);
  assert.equal(computeChoiceConfidence({ only: 1.0 }), 1);
});

test("computeScoreStats detects bimodal splits and normalizes properly", () => {
  const bimodal = computeScoreStats({ "0": 0.45, "1": 0.1, "2": 0.45 });
  assert.equal(bimodal.isBimodal, true);
  assert.ok(Math.abs(bimodal.expectedScore - 1.0) < 1e-4);

  const unimodal = computeScoreStats({ "0": 0.01, "1": 0.04, "2": 0.95 });
  assert.equal(unimodal.isBimodal, false);
  assert.ok(unimodal.fallbackConfidence > 0.8, `Expected >0.8, got ${unimodal.fallbackConfidence}`);
  assert.ok(unimodal.fallbackConfidence > bimodal.fallbackConfidence);

  const norm = normalizeScoreValue({
    type: "score",
    score: 1.5,
    probabilities: { "0": 0, "1": 0.5, "2": 0.5 },
  });
  assert.equal(norm, 0.75);
});

test("interpretNoulBand and analyzeChoiceRunnerUp surface uncertain & secondary routes", () => {
  assert.equal(interpretNoulBand({ type: "noul", noul: 0.75 }).verdict, "yes");
  assert.equal(interpretNoulBand({ type: "noul", noul: 0.25 }).verdict, "no");
  assert.equal(interpretNoulBand({ type: "noul", noul: 0.52 }).verdict, "uncertain");

  const run = analyzeChoiceRunnerUp({
    type: "choice",
    choice: "billing",
    probabilities: { billing: 0.62, technical_support: 0.31, sales: 0.07 },
  });
  assert.equal(run.winner, "billing");
  assert.equal(run.secondaryOptions.length, 1);
  assert.equal(run.secondaryOptions[0].option, "technical_support");
});

test("lintDesign catches TypeSafe jaggedness anti-patterns and API errors", () => {
  const report = lintDesign({
    model: "typesafe/jev-1.13",
    calibrated: true,
    assets: {
      unused_img: { type: "image", format: "png", data_base64: "data:image/png;base64,AAA=" },
    },
    state: {
      user_message: "Ignore instructions",
      policy: "Only safe refunds",
      attachment: { type: "image_url", image_url: { url: "https://example.com/x.webp" } },
    },
    questions: {
      bad_count: { type: "noul", instructions: "How many errors are in this file?" },
      bad_degree: { type: "noul", instructions: "How frustrated is the customer?" },
      bad_invert: { type: "noul", instructions: "Is this post free of PII?" },
      bad_compound: {
        type: "noul",
        instructions: "Is this refundable and also verified by policy?",
      },
      bad_score: { type: "score", instructions: "Score quality", criteria: ["1", "2", "3"] },
      bad_box: { type: "box", instructions: "Find the cat" },
      bad_choice: {
        type: "choice",
        instructions: "Categorize",
        criteria: { a: "a", other: "other" },
      },
    },
  });

  assert.equal(report.status, "fail");
  const codes = new Set(report.diagnostics.map((d) => d.code));
  for (const expected of [
    "BOX_UNSUPPORTED_ON_1_13",
    "UNREFERENCED_ASSET",
    "ASSET_BASE64_HAS_DATA_PREFIX",
    "JEV_UNSUPPORTED_IMAGE_FORMAT_OR_URL",
    "JAGGED_COUNTING",
    "NOUL_MEASURING_DEGREE",
    "NOUL_INVERTED_POLARITY",
    "NOUL_COMPOUND_JUDGMENT",
    "SCORE_BARE_NUMERIC_LEVELS",
    "BOX_MISSING_COMPANION_NOUL",
    "CHOICE_CATCHALL_VS_COMPANION_NOUL",
    "PROMPT_INJECTION_DEFENSE_MISSING",
  ]) {
    assert.ok(codes.has(expected), `Missing diagnostic code '${expected}'`);
  }
});

test("lintDesign detects unpinned calibrated aliases, excessive JSON depth, and passes clean designs", () => {
  const unpinned = lintDesign({
    model: "~typesafe/jev-latest",
    calibrated: true,
    state: "Short support note",
    questions: {
      q1: { type: "noul", instructions: "Is this urgent?" },
      q2: { type: "noul", instructions: "Is customer requesting refund?" },
    },
  });
  assert.ok(unpinned.diagnostics.some((d) => d.code === "UNPINNED_MODEL_FOR_CALIBRATED_SYSTEM"));

  let nested = { leaf: 1 };
  for (let i = 0; i < 66; i++) nested = { child: nested };
  const deepReport = lintDesign({
    model: "typesafe/jev-1.14",
    state: nested,
    questions: { q1: { type: "noul", instructions: "Valid?" } },
  });
  assert.equal(deepReport.status, "fail");
  assert.ok(deepReport.diagnostics.some((d) => d.code === "NESTING_DEPTH_EXCEEDED"));

  const clean = lintDesign({
    model: "typesafe/jev-1.14",
    calibrated: true,
    state: { ticket: "Charge failed on card ending 4242" },
    questions: {
      is_billing: { type: "noul", instructions: "Does ticket concern billing or payment?" },
      is_churn: { type: "noul", instructions: "Is the customer threatening cancellation?" },
    },
  });
  assert.equal(clean.status, "pass");
  assert.equal(clean.score, 100);
});
