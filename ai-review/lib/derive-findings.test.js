"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { deriveArtifacts } = require("./derive-findings.js");

// The model emits ONE schema-validated blob. These files are split out of it
// deterministically, so the shape is enforced by --json-schema at the point of
// generation rather than asked for in prose and validated after the fact.

const review = (over = {}) => ({
  verdict: "fail",
  confidence: 85,
  merge_risk: "medium",
  intent: "aligned",
  counts: { p0: 0, p1: 1, p2: 0, p3: 0 },
  review_event: "REQUEST_CHANGES",
  comment_markdown: "…",
  files_reviewed: ["src/a.ts", "src/b.ts"],
  checklist: [],
  findings: [
    {
      id: "review-serial/0001",
      file: "src/a.ts",
      line: 84,
      severity: "P1",
      summary: "off-by-one",
      failure_scenario: "len==0 -> index -1",
      reason: "bug",
      evidence: "line 84",
      confidence: 75,
      severity_confirmed: "P1",
    },
  ],
  ...over,
});

test("splits one blob into the two artifacts aggregate() expects", () => {
  const out = deriveArtifacts(review(), { role: "review-serial" });
  assert.equal(out.findings.schema, 1);
  assert.equal(out.findings.role, "review-serial");
  assert.equal(out.findings.complete, true);
  assert.equal(out.findings.intent, "aligned");
  assert.deepEqual(out.findings.files_reviewed, ["src/a.ts", "src/b.ts"]);
  assert.equal(out.findings.findings.length, 1);

  assert.equal(out.scores.schema, 1);
  assert.equal(out.scores.complete, true);
  assert.deepEqual(out.scores.scores, [
    { id: "review-serial/0001", confidence: 75, severity_confirmed: "P1" },
  ]);
});

test("assigned_files comes from the manifest, not the model", () => {
  const out = deriveArtifacts(review(), {
    role: "review-serial",
    assignedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
  });
  assert.deepEqual(out.findings.assigned_files, ["src/a.ts", "src/b.ts", "src/c.ts"]);
});

test("every finding gets a score entry — the join can never be short", () => {
  const r = review({
    findings: [
      { id: "x/1", file: "a", line: 1, severity: "P0", summary: "s", failure_scenario: "f", reason: "bug", evidence: "e", confidence: 100 },
      { id: "x/2", file: "b", line: 2, severity: "P2", summary: "s", failure_scenario: "f", reason: "perf", evidence: "e", confidence: 50 },
    ],
  });
  const out = deriveArtifacts(r, { role: "review-serial" });
  assert.deepEqual(
    out.scores.scores.map((s) => s.id),
    out.findings.findings.map((f) => f.id),
  );
});

test("severity_confirmed defaults to the finding's own severity when absent", () => {
  const r = review({
    findings: [{ id: "x/1", file: "a", line: 1, severity: "P1", summary: "s", failure_scenario: "f", reason: "bug", evidence: "e", confidence: 100 }],
  });
  const out = deriveArtifacts(r, { role: "review-serial" });
  assert.equal(out.scores.scores[0].severity_confirmed, "P1");
});

test("returns null when the model omitted the optional findings block", () => {
  const r = review();
  delete r.findings;
  assert.equal(deriveArtifacts(r, { role: "review-serial" }), null);
});

test("returns null when files_reviewed is absent — coverage cannot be asserted", () => {
  const r = review();
  delete r.files_reviewed;
  assert.equal(deriveArtifacts(r, { role: "review-serial" }), null);
});

test("an empty findings array is a real clean result, not a missing block", () => {
  const out = deriveArtifacts(review({ findings: [] }), { role: "review-serial" });
  assert.notEqual(out, null);
  assert.deepEqual(out.findings.findings, []);
  assert.deepEqual(out.scores.scores, []);
});

test("null/garbage input never throws", () => {
  for (const bad of [null, undefined, 42, "x", {}]) {
    assert.equal(deriveArtifacts(bad, { role: "r" }), null, String(bad));
  }
});

test("output is JSON-serialisable and stable", () => {
  const a = deriveArtifacts(review(), { role: "review-serial" });
  const b = deriveArtifacts(review(), { role: "review-serial" });
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});
