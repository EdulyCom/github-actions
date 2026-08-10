"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { aggregate } = require("./aggregate.js");

// --- fixtures ----------------------------------------------------------------

const manifest = (over = {}) => ({
  schema: 1,
  changed_files: ["src/a.ts", "src/b.ts"],
  empty_diff: false,
  title_ok: true,
  has_test_change: true,
  has_logic_change: true,
  no_tests_for_changed_logic: false,
  modifies_reviewer_guidance: false,
  ...over,
});

const finding = (over = {}) => ({
  id: "review-serial/0001",
  file: "src/a.ts",
  line: 84,
  severity: "P1",
  summary: "off-by-one on a boundary",
  failure_scenario: "len==0 -> reads index -1",
  reason: "bug",
  evidence: "line 84",
  ...over,
});

const roleFile = (over = {}) => ({
  schema: 1,
  role: "review-serial",
  complete: true,
  model_used: "claude-sonnet-5",
  assigned_files: ["src/a.ts", "src/b.ts"],
  files_reviewed: ["src/a.ts", "src/b.ts"],
  intent: "aligned",
  checklist: [],
  findings: [],
  ...over,
});

const scoresFor = (ids, over = {}) => ({
  schema: 1,
  role: "scorer",
  complete: true,
  scores: ids.map((id) => ({ id, confidence: 90, severity_confirmed: "P1" })),
  ...over,
});

const run = (over = {}) =>
  aggregate({
    manifest: manifest(),
    roster: ["review-serial"],
    findings: { "review-serial": roleFile() },
    scores: scoresFor([]),
    ...over,
  });

// --- the happy paths ---------------------------------------------------------

test("row 7: zero findings with full coverage is a real PASS, not an error", () => {
  const out = run();
  assert.equal(out.status, "ok");
  assert.equal(out.reason, null);
  assert.deepEqual(out.review.counts, { p0: 0, p1: 0, p2: 0, p3: 0 });
  assert.equal(out.coverage.expected_files, 2);
  assert.equal(out.coverage.reviewed_files, 2);
});

test("a scored finding survives and is counted", () => {
  const f = finding();
  const out = run({
    findings: { "review-serial": roleFile({ findings: [f] }) },
    scores: scoresFor([f.id]),
  });
  assert.equal(out.status, "ok");
  assert.equal(out.review.counts.p1, 1);
  assert.equal(out.kept.length, 1);
  assert.equal(out.dropped.length, 0);
});

// --- fail-closed matrix ------------------------------------------------------

test("row 1: an empty diff is a fail, never a pass", () => {
  const out = run({ manifest: manifest({ empty_diff: true, changed_files: [] }) });
  assert.equal(out.status, "inconclusive");
  assert.match(out.reason, /empty-diff/);
});

test("row 3: no role output at all", () => {
  const out = run({ findings: {} });
  assert.equal(out.status, "inconclusive");
  assert.match(out.reason, /no-findings/);
});

test("row 4: a dead role is named, and absence never reads as clean", () => {
  const out = run({
    roster: ["review-serial", "tracer"],
    findings: { "review-serial": roleFile() },
  });
  assert.equal(out.status, "inconclusive");
  assert.match(out.reason, /missing-role:tracer/);
});

test("row 5: malformed role file — bad schema, missing complete, complete:false", () => {
  for (const bad of [
    null,
    { schema: 2, role: "review-serial", complete: true, findings: [] },
    { schema: 1, role: "review-serial", findings: [] },
    roleFile({ complete: false }),
    roleFile({ findings: "not-an-array" }),
  ]) {
    const out = run({ findings: { "review-serial": bad } });
    assert.equal(out.status, "inconclusive", JSON.stringify(bad));
    assert.match(out.reason, /malformed|missing-role/);
  }
});

test("row 6: coverage mismatch — reviewed fewer files than assigned", () => {
  const out = run({
    findings: {
      "review-serial": roleFile({ files_reviewed: ["src/a.ts"] }),
    },
  });
  assert.equal(out.status, "inconclusive");
  assert.match(out.reason, /coverage/);
  assert.equal(out.coverage.reviewed_files, 1);
  assert.equal(out.coverage.expected_files, 2);
});

test("row 6: partition integrity — roles must cover changed_files exactly", () => {
  const out = run({
    findings: {
      "review-serial": roleFile({
        assigned_files: ["src/a.ts"],
        files_reviewed: ["src/a.ts"],
      }),
    },
  });
  assert.equal(out.status, "inconclusive");
  assert.match(out.reason, /coverage|partition/);
});

test("row 8: scorer file missing or incomplete", () => {
  for (const bad of [null, { schema: 1, role: "scorer", complete: false, scores: [] }]) {
    const f = finding();
    const out = run({
      findings: { "review-serial": roleFile({ findings: [f] }) },
      scores: bad,
    });
    assert.equal(out.status, "inconclusive");
    assert.match(out.reason, /scores/);
  }
});

test("row 9: an unscored finding is a hard fail, never a silent drop", () => {
  const f = finding();
  const out = run({
    findings: { "review-serial": roleFile({ findings: [f] }) },
    scores: scoresFor([]),
  });
  assert.equal(out.status, "inconclusive");
  assert.match(out.reason, /score-gap/);
});

test("row 9: a score for an unknown finding is also a gap (both directions)", () => {
  const out = run({ scores: scoresFor(["review-serial/9999"]) });
  assert.equal(out.status, "inconclusive");
  assert.match(out.reason, /score-gap/);
});

test("row 10: intent must be present and valid", () => {
  for (const bad of [undefined, null, "", "maybe"]) {
    const out = run({ findings: { "review-serial": roleFile({ intent: bad }) } });
    assert.equal(out.status, "inconclusive", String(bad));
    assert.match(out.reason, /intent/);
  }
  for (const ok of ["aligned", "partial", "deviated", "skipped"]) {
    const out = run({ findings: { "review-serial": roleFile({ intent: ok }) } });
    assert.equal(out.status, "ok", ok);
  }
});

// --- §7a severity-tiered confidence filter -----------------------------------

test("§7a: a P0 at confidence 60 SURVIVES (recall bias on blocking findings)", () => {
  const f = finding({ severity: "P0" });
  const out = run({
    findings: { "review-serial": roleFile({ findings: [f] }) },
    scores: scoresFor([f.id], {
      scores: [{ id: f.id, confidence: 60, severity_confirmed: "P0" }],
    }),
  });
  assert.equal(out.review.counts.p0, 1);
  assert.equal(out.dropped.length, 0);
});

test("§7a: a P3 at confidence 60 is DROPPED (noise control), never silently", () => {
  const f = finding({ severity: "P3" });
  const out = run({
    findings: { "review-serial": roleFile({ findings: [f] }) },
    scores: scoresFor([f.id], {
      scores: [{ id: f.id, confidence: 60, severity_confirmed: "P3" }],
    }),
  });
  assert.equal(out.review.counts.p3, 0);
  assert.equal(out.dropped.length, 1);
  assert.equal(out.status, "ok");
});

test("§7a: thresholds are >=50 for P0/P1 and >=80 for P2/P3", () => {
  const cases = [
    ["P0", 50, true], ["P0", 49, false],
    ["P1", 50, true], ["P1", 49, false],
    ["P2", 80, true], ["P2", 79, false],
    ["P3", 80, true], ["P3", 79, false],
  ];
  for (const [sev, conf, keep] of cases) {
    const f = finding({ severity: sev });
    const out = run({
      findings: { "review-serial": roleFile({ findings: [f] }) },
      scores: scoresFor([f.id], {
        scores: [{ id: f.id, confidence: conf, severity_confirmed: sev }],
      }),
    });
    assert.equal(out.kept.length, keep ? 1 : 0, `${sev}@${conf}`);
  }
});

// --- §7b severity reconciliation ---------------------------------------------

test("§7b: reconciliation takes the MORE severe of finder and scorer", () => {
  const f = finding({ severity: "P2" });
  const out = run({
    findings: { "review-serial": roleFile({ findings: [f] }) },
    scores: scoresFor([f.id], {
      scores: [{ id: f.id, confidence: 90, severity_confirmed: "P0" }],
    }),
  });
  assert.equal(out.review.counts.p0, 1);
  assert.equal(out.review.counts.p2, 0);
});

test("§7b: reconciliation runs BEFORE the filter, so an upgrade cannot be filtered away", () => {
  // Finder says P2 (would need >=80); scorer upgrades to P1 (needs >=50) at 60.
  // Filtering on the finder's label first would drop a confirmed P1 blocker.
  const f = finding({ severity: "P2" });
  const out = run({
    findings: { "review-serial": roleFile({ findings: [f] }) },
    scores: scoresFor([f.id], {
      scores: [{ id: f.id, confidence: 60, severity_confirmed: "P1" }],
    }),
  });
  assert.equal(out.review.counts.p1, 1);
  assert.equal(out.dropped.length, 0);
});

// --- §6.6 dedupe / §6.7 deterministic injection ------------------------------

test("§6.6: identical file+line+reason dedupes; different reason does not", () => {
  const a = finding({ id: "review-serial/0001" });
  const b = finding({ id: "review-serial/0002" });
  const c = finding({ id: "review-serial/0003", reason: "perf" });
  const out = run({
    findings: { "review-serial": roleFile({ findings: [a, b, c] }) },
    scores: scoresFor([a.id, b.id, c.id]),
  });
  assert.equal(out.kept.length, 2);
  assert.equal(out.review.counts.p1, 2);
});

test("§6.7: a non-Conventional title injects a P2 with no model involvement", () => {
  const out = run({ manifest: manifest({ title_ok: false }) });
  assert.equal(out.review.counts.p2, 1);
  assert.match(out.kept[0].id, /^deterministic\//);
});

test("§6.7: touching reviewer guidance injects a P2 that cannot be suppressed", () => {
  const out = run({ manifest: manifest({ modifies_reviewer_guidance: true }) });
  assert.equal(out.review.counts.p2, 1);
});

// --- §6.10 the recompute contract --------------------------------------------

test("no_tests_for_changed_logic comes from the manifest, not the model", () => {
  const out = run({ manifest: manifest({ no_tests_for_changed_logic: true }) });
  assert.equal(out.review.no_tests_for_changed_logic, true);
});

test("review object is exactly recompute()'s parameter shape", () => {
  const out = run();
  assert.deepEqual(Object.keys(out.review).sort(), [
    "checklist",
    "counts",
    "coverage_below_threshold_on_critical_paths",
    "intent",
    "no_tests_for_changed_logic",
    "test_execution",
    "tests_failing",
    "verification_evidence",
  ]);
  assert.equal(out.review.test_execution, "skipped");
  assert.equal(out.review.tests_failing, false);
  assert.deepEqual(out.review.verification_evidence, []);
});

test("model-reported counts are never read", () => {
  const out = run({
    findings: {
      "review-serial": roleFile({ counts: { p0: 9, p1: 9, p2: 9, p3: 9 } }),
    },
  });
  assert.deepEqual(out.review.counts, { p0: 0, p1: 0, p2: 0, p3: 0 });
});

// --- scale -------------------------------------------------------------------

test("the 41-file heavy shape aggregates without loss", () => {
  const files = Array.from({ length: 41 }, (_, i) => `src/f${i}.ts`);
  const findings = files.map((f, i) =>
    finding({ id: `review-serial/${String(i).padStart(4, "0")}`, file: f, line: i + 1 }),
  );
  const out = aggregate({
    manifest: manifest({ changed_files: files }),
    roster: ["review-serial"],
    findings: {
      "review-serial": roleFile({
        assigned_files: files,
        files_reviewed: files,
        findings,
      }),
    },
    scores: scoresFor(findings.map((f) => f.id)),
  });
  assert.equal(out.status, "ok");
  assert.equal(out.review.counts.p1, 41);
  assert.equal(out.coverage.reviewed_files, 41);
});
