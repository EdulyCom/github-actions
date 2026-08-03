"use strict";

// Deterministic pass/fail recomputation for the ai-review gate.
//
// Extracted from the Publish step's inline github-script block so the
// arithmetic is unit-testable: issue #25 (a P2-only diff failing the gate)
// survived for a month precisely because nothing here could be exercised
// without paying for a live Opus review.
//
// Pure: no I/O, no GitHub API, no process.env. The caller supplies the
// threshold and CI signal.

const P0_WEIGHT = 30;
const P1_WEIGHT = 15;
const P2_WEIGHT = 5;

const DEFAULT_THRESHOLD = 90;

const clamp = (n) => Math.max(0, Math.min(100, n));

const plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * @param {object} review  parsed structured output from the review stage
 * @param {{confidenceThreshold: number, ciSignal: string}} options
 */
function recompute(review, options) {
  const r = review || {};
  const opts = options || {};

  const rawThreshold = Number(opts.confidenceThreshold);
  const confidenceThreshold = Number.isFinite(rawThreshold)
    ? rawThreshold
    : DEFAULT_THRESHOLD;

  const rawCounts = r.counts || {};
  const p0 = Number(rawCounts.p0) || 0;
  const p1 = Number(rawCounts.p1) || 0;
  const p2 = Number(rawCounts.p2) || 0;
  const p3 = Number(rawCounts.p3) || 0;

  // Test-quality adjustment (rubric.md "Confidence Rate Calculation").
  // no_tests_for_changed_logic and coverage_below_threshold_on_critical_paths
  // both describe "tests are inadequate" at different severities, so only the
  // worse of the two applies; the failing-tests penalty is independent and
  // stacks (a PR can have adequate but currently-failing tests).
  let testAdjustment = 0;
  if (r.no_tests_for_changed_logic) {
    testAdjustment -= 15;
  } else if (r.coverage_below_threshold_on_critical_paths) {
    testAdjustment -= 5;
  }

  // Real test execution supersedes the static tests_failing guess: a command
  // that actually exited non-zero is a definitive failure. And a "passed"
  // claim with no cited command+output in verification_evidence is unverified
  // per /verification-before-completion, so it earns the same penalty as a
  // failing suite rather than a free pass ("evidence before claims").
  //
  // "skipped" (no toolchain — the caller provisions none, per ADR 0003 §2)
  // and "not_run" (nothing testable in the diff) deliberately carry NO
  // penalty. The authoritative test signal comes from the caller's own CI
  // lanes; this sandbox is not the test oracle. See issue #25 and ADR 0004 —
  // do not add a penalty here.
  const testExecution = r.test_execution || "";
  const verificationEvidence = Array.isArray(r.verification_evidence)
    ? r.verification_evidence
    : [];
  const testsFailing = r.tests_failing === true || testExecution === "failed";
  if (testsFailing) {
    testAdjustment -= 10;
  }
  if (testExecution === "passed" && verificationEvidence.length === 0) {
    testAdjustment -= 10;
  }

  // Two numbers, deliberately:
  //
  // `confidence` is the REPORTED score. It keeps the P2 term so the rubric's
  // calibrated bands (>=85 high / 70-84 medium / 50-69 low) stay meaningful
  // and merge_risk keeps its granularity.
  //
  // `gateConfidence` is what the pass/fail decision compares. It omits P2/P3
  // because the rubric defines those as non-blocking ("P2 - Nice-to-Have:
  // can merge with note; fix in follow-up"). Before this split, the third P2
  // on an otherwise-clean diff took confidence to 85 and hard-failed the
  // gate, making the verdict a coin flip on how many optional nits the model
  // happened to surface.
  const confidence = clamp(
    100 - P0_WEIGHT * p0 - P1_WEIGHT * p1 - P2_WEIGHT * p2 + testAdjustment
  );
  const gateConfidence = clamp(
    100 - P0_WEIGHT * p0 - P1_WEIGHT * p1 + testAdjustment
  );

  // A completed failing/timed-out required-check conclusion (only available on
  // a workflow_dispatch re-review) is an automatic fail, matching the rubric's
  // "failing required CI = auto-P0" rule.
  const ciFailed = opts.ciSignal === "fail" || opts.ciSignal === "timeout";
  const intentDeviated = r.intent === "deviated";

  // Every blocking condition names itself. The Publish step renders these
  // verbatim, so a FAIL always states its own reason — the absence of one is
  // what made issue #25 get misdiagnosed as a test-toolchain problem across
  // three comments and two self-corrections.
  const blockers = [];
  if (p0 > 0) blockers.push(plural(p0, "P0 blocker"));
  if (p1 > 0) blockers.push(plural(p1, "P1 finding"));
  if (gateConfidence < confidenceThreshold) {
    blockers.push(
      `blocking-finding confidence ${gateConfidence} is below the threshold ${confidenceThreshold}`
    );
  }
  if (ciFailed) blockers.push(`a required CI check reported '${opts.ciSignal}'`);
  if (intentDeviated) blockers.push("the diff deviates from the stated intent");

  const pass = blockers.length === 0;

  let mergeRisk;
  if (p0 > 0 || p1 > 2) {
    mergeRisk = "high";
  } else if (p1 >= 1 || confidence < 70) {
    mergeRisk = "medium";
  } else {
    mergeRisk = "low";
  }

  return {
    verdict: pass ? "pass" : "fail",
    confidence,
    gateConfidence,
    mergeRisk,
    reviewEvent: pass ? "APPROVE" : "REQUEST_CHANGES",
    blockers,
    counts: { p0, p1, p2, p3 },
    intentDeviated,
  };
}

module.exports = { recompute };
