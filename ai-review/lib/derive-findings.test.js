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
      // Raw, unprefixed — this fixture exercises the splitting mechanics, not
      // the namespacing edge cases, which have their own dedicated tests below.
      id: "0001",
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

test("assigned_files never falls back to the model's own files_reviewed", () => {
  // The fallback contradicted this module's whole purpose — aggregate.js is
  // supposed to compare a model claim against a deterministic fact, not against
  // another copy of the same claim. It also broke the newer partition check,
  // which requires assigned_files to be a subset of changed_files while
  // files_reviewed is explicitly allowed to range outside the diff (a reviewer
  // reading a neighbouring file for context). An empty assignment makes
  // aggregation fail closed with a diagnosable reason instead.
  const out = deriveArtifacts(review(), { role: "review-serial" });
  assert.deepEqual(out.findings.assigned_files, []);
  assert.deepEqual(out.findings.files_reviewed, ["src/a.ts", "src/b.ts"]);
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

test("ids are namespaced by role, so two reviewers cannot collide", () => {
  // The schema's `id` is a bare string with no format guidance, so two reviewer
  // sessions running the same prompt will plausibly both emit "F1". Aggregation
  // rejects a cross-role duplicate — correctly, since the score join is keyed by
  // id — which would turn two perfectly good non-overlapping reviews into a
  // whole-PR failure. Prefixing here is safe: §6.6 dedupe keys on
  // file+line+reason, not on id, so genuine duplicates still merge.
  const r = review({
    findings: [{ id: "F1", file: "a", line: 1, severity: "P1", summary: "s", failure_scenario: "f", reason: "bug", evidence: "e", confidence: 100 }],
  });
  const one = deriveArtifacts(r, { role: "reviewer-1" });
  const two = deriveArtifacts(r, { role: "reviewer-2" });
  assert.equal(one.findings.findings[0].id, "reviewer-1/F1");
  assert.equal(two.findings.findings[0].id, "reviewer-2/F1");
  assert.notEqual(one.findings.findings[0].id, two.findings.findings[0].id);
  // the score side must move with it or the join breaks
  assert.equal(one.scores.scores[0].id, "reviewer-1/F1");
});

test("namespacing is unconditional, so two ids can never collide by prefix guessing", () => {
  // A conditional prefix — skip if raw already starts with "role/" — was tried
  // first, to avoid double-prefixing an id a well-behaved model already
  // namespaced itself. But a model told its ids are namespaced can apply the
  // convention inconsistently within one response: one finding's raw id is
  // "F1", another's is "reviewer-1/F1". The conditional maps BOTH to
  // "reviewer-1/F1" — the exact cross-role collision namespacing exists to
  // prevent, reached from within a single role instead of across two.
  // Unconditional prefixing is injective: every distinct raw id produces a
  // distinct namespaced one, full stop. "reviewer-1/reviewer-1/0007" reads
  // oddly but is never wrong, and nothing downstream parses id structure.
  const r = review({
    findings: [
      { id: "F1", file: "a", line: 1, severity: "P1", summary: "s", failure_scenario: "f", reason: "bug", evidence: "e", confidence: 100 },
      { id: "reviewer-1/F1", file: "b", line: 2, severity: "P2", summary: "s", failure_scenario: "f", reason: "perf", evidence: "e", confidence: 75 },
    ],
  });
  const out = deriveArtifacts(r, { role: "reviewer-1" });
  const ids = out.findings.findings.map((f) => f.id);
  assert.equal(new Set(ids).size, 2, `collided: ${ids}`);
  assert.deepEqual(ids, ["reviewer-1/F1", "reviewer-1/reviewer-1/F1"]);
});

test("a model id and a generated fallback id in the same role cannot collide", () => {
  // Unconditional prefixing is injective on the PREFIX; it says nothing about
  // the value being prefixed. A model returning "0002" for finding 0, and
  // omitting an id for finding 1 (which falls back to index 1 -> "0002" under
  // the old unstemmed fallback), both namespaced to "review-serial/0002" —
  // aggregate.js's shared ids Set then rejected the whole review as
  // malformed:review-serial:duplicate. Four-digit zero-padded ids are this
  // system's own house style, so the collision was not a contrived edge case.
  const r = review({
    findings: [
      { id: "0002", file: "a", line: 1, severity: "P1", summary: "s", failure_scenario: "f", reason: "bug", evidence: "e", confidence: 100 },
      { id: "", file: "b", line: 2, severity: "P2", summary: "s", failure_scenario: "f", reason: "perf", evidence: "e", confidence: 75 },
    ],
  });
  const out = deriveArtifacts(r, { role: "review-serial" });
  const ids = out.findings.findings.map((f) => f.id);
  assert.equal(new Set(ids).size, 2, `collided: ${ids}`);
  assert.deepEqual(ids, ["review-serial/0002", "review-serial/auto-0002"]);
});

test("a model id that literally matches the generated shape is reserved, not trusted", () => {
  // "auto-" narrows the collision window but isn't reserved on its own — a
  // model that happens to emit the literal string "auto-0002" would still
  // collide with whichever finding's OWN fallback that is. Any raw id shaped
  // like a generated one is never trusted as a model value: it is always
  // replaced by THIS finding's own generatedId(i), which is injective over
  // index, so two findings can never be forced to the same id however a model
  // spells its own.
  const r = review({
    findings: [
      { id: "auto-0002", file: "a", line: 1, severity: "P1", summary: "s", failure_scenario: "f", reason: "bug", evidence: "e", confidence: 100 },
      { id: "", file: "b", line: 2, severity: "P2", summary: "s", failure_scenario: "f", reason: "perf", evidence: "e", confidence: 75 },
    ],
  });
  const out = deriveArtifacts(r, { role: "review-serial" });
  const ids = out.findings.findings.map((f) => f.id);
  assert.equal(new Set(ids).size, 2, `collided: ${ids}`);
  assert.deepEqual(ids, ["review-serial/auto-0001", "review-serial/auto-0002"]);
});

test("two findings sharing the same plain raw id are disambiguated, not collided", () => {
  // The schema requires no uniqueness on `id` — a model describing two real
  // defects with the same lazy "F1" is not contrived. Namespacing and the
  // auto- reservation each operate on one id at a time and can't see a repeat
  // two slots later; without dedup, aggregate.js's shared ids Set would reject
  // the whole role as malformed:duplicate over an id string, discarding two
  // real findings.
  const r = review({
    findings: [
      { id: "F1", file: "a", line: 1, severity: "P1", summary: "s", failure_scenario: "f", reason: "bug", evidence: "e", confidence: 100 },
      { id: "F1", file: "b", line: 2, severity: "P2", summary: "s", failure_scenario: "f", reason: "perf", evidence: "e", confidence: 75 },
    ],
  });
  const out = deriveArtifacts(r, { role: "review-serial" });
  const ids = out.findings.findings.map((f) => f.id);
  assert.equal(new Set(ids).size, 2, `collided: ${ids}`);
  assert.deepEqual(ids, ["review-serial/F1", "review-serial/F1-2"]);
  // the score side must move with it or the join breaks
  assert.deepEqual(out.scores.scores.map((s) => s.id), ids);
});

test("three-way and chained collisions all resolve to distinct ids", () => {
  const r = review({
    findings: [
      { id: "F1", file: "a", line: 1, severity: "P1", summary: "s", failure_scenario: "f", reason: "bug", evidence: "e", confidence: 100 },
      { id: "F1", file: "b", line: 2, severity: "P2", summary: "s", failure_scenario: "f", reason: "bug", evidence: "e", confidence: 75 },
      // Collides with what the second F1 above resolves to, forcing a second bump.
      { id: "F1-2", file: "c", line: 3, severity: "P3", summary: "s", failure_scenario: "f", reason: "bug", evidence: "e", confidence: 75 },
    ],
  });
  const out = deriveArtifacts(r, { role: "review-serial" });
  const ids = out.findings.findings.map((f) => f.id);
  assert.equal(new Set(ids).size, 3, `collided: ${ids}`);
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
