"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { recompute } = require("./recompute.js");

const OPTS = { confidenceThreshold: 90, ciSignal: "no_ci" };
const clean = (over) =>
  Object.assign({ counts: { p0: 0, p1: 0, p2: 0, p3: 0 }, intent: "aligned" }, over);

test("regression #25: three P2 nice-to-haves and no blockers passes", () => {
  // PR EdulyCom/eduly#3818 @ 16:56 and 18:20 UTC: confidence 85, merge_risk low.
  // Before this fix the gate compared 85 against 90 and failed.
  const r = recompute(clean({ counts: { p0: 0, p1: 0, p2: 3, p3: 1 } }), OPTS);
  assert.equal(r.verdict, "pass");
  assert.equal(r.confidence, 85, "displayed confidence keeps the P2 term");
  assert.equal(r.gateConfidence, 100, "gate confidence excludes P2/P3");
  assert.equal(r.mergeRisk, "low");
  assert.deepEqual(r.blockers, []);
});

test("P2 count never blocks, however large", () => {
  const r = recompute(clean({ counts: { p0: 0, p1: 0, p2: 40, p3: 9 } }), OPTS);
  assert.equal(r.verdict, "pass");
  assert.equal(r.confidence, 0, "displayed confidence clamps at 0");
  assert.equal(r.gateConfidence, 100);
});

test("a single P1 fails the gate", () => {
  const r = recompute(clean({ counts: { p0: 0, p1: 1, p2: 0, p3: 0 } }), OPTS);
  assert.equal(r.verdict, "fail");
  assert.equal(r.reviewEvent, "REQUEST_CHANGES");
  assert.ok(r.blockers.some((b) => b.includes("P1")));
});

test("a single P0 fails the gate", () => {
  const r = recompute(clean({ counts: { p0: 1, p1: 0, p2: 0, p3: 0 } }), OPTS);
  assert.equal(r.verdict, "fail");
  assert.equal(r.mergeRisk, "high");
  assert.ok(r.blockers.some((b) => b.includes("P0")));
});

test("test_execution 'skipped' carries no penalty (issue #25 stated ask)", () => {
  const r = recompute(clean({ test_execution: "skipped" }), OPTS);
  assert.equal(r.verdict, "pass");
  assert.equal(r.gateConfidence, 100);
  assert.deepEqual(r.blockers, []);
});

test("test_execution 'not_run' carries no penalty", () => {
  const r = recompute(clean({ test_execution: "not_run" }), OPTS);
  assert.equal(r.verdict, "pass");
  assert.equal(r.gateConfidence, 100);
});

test("test_execution 'failed' costs 10 and still counts toward the gate", () => {
  const r = recompute(clean({ test_execution: "failed" }), OPTS);
  assert.equal(r.gateConfidence, 90, "100 minus 10");
  assert.equal(r.verdict, "pass", "90 meets the default threshold exactly");

  const worse = recompute(
    clean({ test_execution: "failed", coverage_below_threshold_on_critical_paths: true }),
    OPTS
  );
  assert.equal(worse.gateConfidence, 85);
  assert.equal(worse.verdict, "fail");
});

test("tests_failing boolean alone costs 10", () => {
  const r = recompute(clean({ tests_failing: true }), OPTS);
  assert.equal(r.gateConfidence, 90);
});

test("'passed' with no verification evidence costs 10", () => {
  const r = recompute(clean({ test_execution: "passed" }), OPTS);
  assert.equal(r.gateConfidence, 90);
});

test("'passed' with verification evidence costs nothing", () => {
  const r = recompute(
    clean({
      test_execution: "passed",
      verification_evidence: [{ claim: "suite green", command: "npm test", result: "0 failures" }],
    }),
    OPTS
  );
  assert.equal(r.gateConfidence, 100);
});

test("no tests for changed logic still blocks the gate", () => {
  const r = recompute(clean({ no_tests_for_changed_logic: true }), OPTS);
  assert.equal(r.gateConfidence, 85);
  assert.equal(r.verdict, "fail");
  assert.ok(r.blockers.some((b) => b.includes("threshold")));
});

test("the worse of the two coverage penalties applies, not both", () => {
  const r = recompute(
    clean({ no_tests_for_changed_logic: true, coverage_below_threshold_on_critical_paths: true }),
    OPTS
  );
  assert.equal(r.gateConfidence, 85, "-15 only, not -20");
});

test("gate confidence exactly at the threshold passes", () => {
  const r = recompute(clean({ no_tests_for_changed_logic: true }), {
    confidenceThreshold: 85,
    ciSignal: "no_ci",
  });
  assert.equal(r.verdict, "pass");
});

test("a failing CI signal blocks", () => {
  const r = recompute(clean({}), { confidenceThreshold: 90, ciSignal: "fail" });
  assert.equal(r.verdict, "fail");
  assert.ok(r.blockers.some((b) => b.includes("CI")));
});

test("a timed-out CI signal blocks", () => {
  const r = recompute(clean({}), { confidenceThreshold: 90, ciSignal: "timeout" });
  assert.equal(r.verdict, "fail");
});

test("a passing CI signal does not block", () => {
  const r = recompute(clean({}), { confidenceThreshold: 90, ciSignal: "pass" });
  assert.equal(r.verdict, "pass");
});

test("deviated intent blocks even with a perfect score", () => {
  const r = recompute(clean({ intent: "deviated" }), OPTS);
  assert.equal(r.verdict, "fail");
  assert.equal(r.intentDeviated, true);
  assert.ok(r.blockers.some((b) => b.includes("intent")));
});

test("merge risk bands", () => {
  assert.equal(recompute(clean({}), OPTS).mergeRisk, "low");
  assert.equal(
    recompute(clean({ counts: { p0: 0, p1: 1, p2: 0, p3: 0 } }), OPTS).mergeRisk,
    "medium"
  );
  assert.equal(
    recompute(clean({ counts: { p0: 0, p1: 3, p2: 0, p3: 0 } }), OPTS).mergeRisk,
    "high"
  );
  assert.equal(
    recompute(clean({ counts: { p0: 0, p1: 0, p2: 7, p3: 0 } }), OPTS).mergeRisk,
    "medium",
    "displayed confidence 65 is below 70"
  );
});

test("a non-finite threshold falls back to 90", () => {
  const r = recompute(clean({ no_tests_for_changed_logic: true }), {
    confidenceThreshold: Number.NaN,
    ciSignal: "no_ci",
  });
  assert.equal(r.verdict, "fail", "85 < the 90 fallback");
});

test("missing counts are treated as zero", () => {
  const r = recompute({ intent: "aligned" }, OPTS);
  assert.equal(r.verdict, "pass");
  assert.deepEqual(r.counts, { p0: 0, p1: 0, p2: 0, p3: 0 });
});

test("blockers read as a human sentence fragment", () => {
  const r = recompute(clean({ counts: { p0: 1, p1: 2, p2: 0, p3: 0 } }), OPTS);
  assert.equal(r.blockers[0], "1 P0 blocker");
  assert.equal(r.blockers[1], "2 P1 findings");
});
