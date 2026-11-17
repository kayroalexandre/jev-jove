---
name: jev-calibrate
description: >-
  Automatically calibrate TypeSafe Jev Noul, Choice, and Score pipelines on labeled examples using temperature scaling, ECE/Brier/NLL metrics, self-consistency/permutation checks, 3-lane SLA/cost threshold optimization, and $0 offline re-tuning. Use when tuning thresholds, validating production reliability, or debugging confidence drift.
---

# TypeSafe Jev Auto-Calibration Workflow

Calibrate every production Jev decision point empirically instead of guessing probability cutoffs. Keep models **pinned** (`typesafe/jev-1.14`) before saving calibrated thresholds.

## Calibration Procedure

1. **Pre-Flight Check (`jev_lint_design`)**
   - Lint sample state + question with `calibrated: true` to confirm pinned model ID, crisp phrasing, positive Noul polarity, and zero jaggedness traps.

2. **Run Auto-Calibration (`jev_calibrate_auto`)**
   - Pass labeled samples (`boolean` for `noul`, option key `string` for `choice`, numeric target for `score`).
   - Optionally supply `precomputedAnswer` on all samples to calibrate 100% **offline ($0 spend)**.
   - Set **`checkConsistency: true`** on critical pipelines: executes TypeSafe's throwaway-UID (`_consistency_uid`) repeat stability test (`consistency_noul_cookbook`) and, for Choice questions, permutes option keys (`original`, `reversed`, `rotated`) to detect Choice option-order bias.
   - Set SLA or cost targets matching business risk:
     - High-stakes safety gate: `minApprovePrecision: 0.95`, `minBlockNpv: 0.95`, high `falsePositiveCost` / `falseNegativeCost` vs `reviewCost: 1` -> yields optimal tri-state `approveAt` / `review` / `blockAt`.
     - Classification triage: `targetAccuracy: 0.90` -> finds lowest Choice `confidenceMin` meeting accuracy target with maximum automation coverage.

3. **Inspect Calibration Diagnostics**
   - Compare **Before vs After 1D Temperature Scaling** (`ECE`, `MCE`, `Brier`, `NLL`). Note TypeSafe's confidence bands (`<0.5` low, `0.5-0.8` moderate, `>=0.8` high) to confirm high-confidence predictions achieve strictly higher empirical accuracy.
   - Review the threshold sweep table (`Precision`, `Recall`, `F1`, `Accuracy`, `Positive Rate`).

4. **$0 Offline Re-Tuning (`jev_calibration_profiles`)**
   - Raw probabilities/answers are persisted alongside ground-truth labels in `${PLUGIN_DATA}/calibrations/<profileId>.json`.
   - When business priorities change (e.g. tightening `minApprovePrecision` from `0.90` to `0.98`, or raising `falsePositiveCost`), run `jev_calibration_profiles` with `action: "retune"` for **$0 and 0 API requests**.

5. **Runtime Application & Model Version Guard**
   - Pass `calibrationProfileId` to `jev_decide` or `jev_decide_batch`, or call `jev_calibration_profiles(action="apply")`.
   - If the response model slug diverges from `profile.pinnedModel`, the plugin raises an explicit mismatch warning prompting re-calibration.
