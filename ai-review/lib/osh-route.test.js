"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { COLLAPSE_CHURN_MAX, resolveOshRoute } = require("./osh-route.js");

test("resolveOshRoute: K≤1 collapses regardless of churn", () => {
  const out = resolveOshRoute({ k: 1, churn: 50000 });
  assert.equal(out.oshMode, "collapse");
  assert.equal(out.reason, "k-le-1");
  assert.equal(out.runContextStage, false);
});

test("resolveOshRoute: empty-diff k=0 collapses", () => {
  const out = resolveOshRoute({ k: 0, churn: 0 });
  assert.equal(out.oshMode, "collapse");
  assert.equal(out.reason, "k-le-1");
});

test("resolveOshRoute: K>1 with small churn collapses (eduly #3984 shape)", () => {
  // Full-file bytes pushed K=2 (large landing.css) but churn is a styling tweak.
  const out = resolveOshRoute({ k: 2, churn: 671 });
  assert.equal(out.oshMode, "collapse");
  assert.equal(out.reason, "churn-le-ceiling");
  assert.equal(out.runContextStage, false);
  assert.equal(out.collapseChurnMax, COLLAPSE_CHURN_MAX);
});

test("resolveOshRoute: K>1 at exactly the churn ceiling still collapses", () => {
  const out = resolveOshRoute({ k: 2, churn: COLLAPSE_CHURN_MAX });
  assert.equal(out.oshMode, "collapse");
  assert.equal(out.reason, "churn-le-ceiling");
});

test("resolveOshRoute: K>1 with churn above ceiling fans out", () => {
  const out = resolveOshRoute({ k: 2, churn: COLLAPSE_CHURN_MAX + 1 });
  assert.equal(out.oshMode, "fanout");
  assert.equal(out.reason, "k-gt-1-and-churn-over");
  assert.equal(out.runContextStage, true);
});

test("resolveOshRoute: string inputs from jq/env coerce", () => {
  const out = resolveOshRoute({ k: "3", churn: "800" });
  assert.equal(out.oshMode, "collapse");
  assert.equal(out.k, 3);
  assert.equal(out.churn, 800);
});

test("resolveOshRoute: collapseChurnMax override is respected", () => {
  assert.equal(resolveOshRoute({ k: 2, churn: 900, collapseChurnMax: 800 }).oshMode, "fanout");
  assert.equal(resolveOshRoute({ k: 2, churn: 900, collapseChurnMax: 1000 }).oshMode, "collapse");
});
