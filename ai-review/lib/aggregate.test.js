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

test("row 5: an assigned_files that isn't an array is malformed, not a partition gap", () => {
  // Without this check, a string or null degrades to [] at the partition
  // check (still fails closed) but blames "assigned to no role" on the
  // CHANGED FILE instead of naming the role whose envelope was actually bad —
  // correct direction, wrong suspect.
  for (const bad of ["a,b", null, 42, {}]) {
    const out = run({ findings: { "review-serial": roleFile({ assigned_files: bad }) } });
    assert.equal(out.status, "inconclusive", JSON.stringify(bad));
    assert.match(out.reason, /malformed:review-serial/, `${JSON.stringify(bad)} -> ${out.reason}`);
  }
});

test("row 6: partial files_reviewed is ok — /code-review does not require full-file claims", () => {
  // Skill-led /code-review: reviewers may leave large files as hunk-only.
  // Partition still requires ownership; coverage counts are telemetry only.
  const out = run({
    findings: {
      "review-serial": roleFile({
        files_reviewed: ["src/a.ts", "vendor/x.ts", "vendor/y.ts", "vendor/z.ts"],
      }),
    },
  });
  assert.equal(out.status, "ok");
  assert.equal(out.coverage.reviewed_files, 1, "out-of-diff neighbours must not inflate the count");
  assert.equal(out.coverage.expected_files, 2);
});

test("row 6: reviewed fewer files than assigned is ok under /code-review reads", () => {
  const out = run({
    findings: {
      "review-serial": roleFile({ files_reviewed: ["src/a.ts"] }),
    },
  });
  assert.equal(out.status, "ok");
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
  assert.match(out.reason, /partition/);
});

test("finding ids must be unique ACROSS roles, not just within one", () => {
  // The score join is a Map keyed by id, so a collision silently keeps one
  // finding and discards the other while every set-equality assertion stays
  // green — reproduced earlier as a P0@100 colliding with a P3@25 yielding
  // verdict pass. Ids are model-invented and `derive-findings.js` uses the
  // model's own string when present, so nothing namespaces them by role.
  const f = finding({ id: "collide", severity: "P0" });
  const g = finding({ id: "collide", severity: "P3", file: "src/b.ts" });
  const out = run({
    roster: ["reviewer-1", "reviewer-2"],
    findings: {
      "reviewer-1": roleFile({
        role: "reviewer-1",
        assigned_files: ["src/a.ts"],
        files_reviewed: ["src/a.ts"],
        findings: [f],
      }),
      "reviewer-2": roleFile({
        role: "reviewer-2",
        assigned_files: ["src/b.ts"],
        files_reviewed: ["src/b.ts"],
        findings: [g],
      }),
    },
    scores: scoresFor(["collide"]),
  });
  assert.equal(out.status, "inconclusive");
  assert.match(out.reason, /duplicate finding id collide/);
});

test("row 6: a role assigned a file nobody changed is a partition error", () => {
  const out = run({
    findings: {
      "review-serial": roleFile({
        assigned_files: ["src/a.ts", "src/b.ts", "src/ghost.ts"],
        files_reviewed: ["src/a.ts", "src/b.ts", "src/ghost.ts"],
      }),
    },
  });
  assert.equal(out.status, "inconclusive");
  assert.match(out.reason, /partition/);
  assert.match(out.reason, /src\/ghost\.ts/);
});

test("row 6: a role listing the same file twice in its own assigned_files is a partition error", () => {
  // roster.js's assertPartition throws on any repeated path regardless of
  // which bin(s) it appears in — this module re-asserts that independently,
  // since a role file arrives from a model stage that can claim anything. The
  // cross-role check alone (owner !== role) let this shape through silently.
  const out = run({
    findings: {
      "review-serial": roleFile({
        assigned_files: ["src/a.ts", "src/a.ts", "src/b.ts"],
        files_reviewed: ["src/a.ts", "src/b.ts"],
      }),
    },
  });
  assert.equal(out.status, "inconclusive");
  assert.match(out.reason, /partition/);
  assert.match(out.reason, /src\/a\.ts/);
  assert.match(out.reason, /twice/);
});

test("row 6: a changed file assigned to no role is a partition error", () => {
  // Distinct from the reviewed-by-nobody case: a file can be incidentally read
  // by a role it was never assigned to, which would satisfy a files_reviewed
  // union while nobody actually owned it.
  const out = run({
    findings: {
      "review-serial": roleFile({
        assigned_files: ["src/a.ts"],
        files_reviewed: ["src/a.ts", "src/b.ts"],
      }),
    },
  });
  assert.equal(out.status, "inconclusive");
  assert.match(out.reason, /partition/);
  assert.match(out.reason, /src\/b\.ts/);
});

test("reviewed_files counts the diff, so it can never exceed expected_files", () => {
  // files_reviewed is explicitly allowed to range outside the diff — reading a
  // neighbour for context is what a reviewer should do — so a raw tally gives
  // "expected 2, reviewed 5", which reads as nonsense and is the number fan-out
  // will scrape per role.
  const out = run({
    findings: {
      "review-serial": roleFile({
        files_reviewed: ["src/a.ts", "src/b.ts", "vendor/x.ts", "vendor/y.ts", "vendor/z.ts"],
      }),
    },
  });
  assert.equal(out.status, "ok");
  assert.equal(out.coverage.expected_files, 2);
  assert.equal(out.coverage.reviewed_files, 2);
});

test("a dead or malformed role reports the real file count, not an empty diff's", () => {
  // inconclusive() defaults to expected_files: 0, so these exits logged the same
  // tally an empty diff logs. Every other exit passes coverage explicitly.
  const dead = run({ roster: ["review-serial", "tracer"] });
  assert.match(dead.reason, /missing-role:tracer/);
  assert.equal(dead.coverage.expected_files, 2);

  const bad = run({ findings: { "review-serial": roleFile({ schema: 2 }) } });
  assert.match(bad.reason, /malformed/);
  assert.equal(bad.coverage.expected_files, 2);
});

test("dedupe normalises the path, so './x' and 'x' are one finding", () => {
  // finding.file is model-typed text and malformed() never touches it, while
  // every partition and coverage comparison in the module goes through
  // normPath. Two roles spelling the same path differently counted the same
  // defect twice. It fails closed, so this is a weaker-than-intended §6.6
  // rather than a fail-open — but the fix costs nothing.
  const a = finding({ id: "r1/1", file: "src/a.ts", line: 84, reason: "bug" });
  const b = finding({ id: "r2/1", file: "./src/a.ts", line: 84, reason: "bug" });
  const out = run({
    roster: ["reviewer-1", "reviewer-2"],
    findings: {
      "reviewer-1": roleFile({ role: "reviewer-1", assigned_files: ["src/a.ts"], files_reviewed: ["src/a.ts"], findings: [a] }),
      "reviewer-2": roleFile({ role: "reviewer-2", assigned_files: ["src/b.ts"], files_reviewed: ["src/b.ts"], findings: [b] }),
    },
    scores: scoresFor(["r1/1", "r2/1"]),
  });
  assert.equal(out.status, "ok");
  assert.equal(out.review.counts.p1, 1, "the same defect counted twice");
});

test("a partition failure does not report a misleading reviewed count", () => {
  // The count is of files verified as reviewed; at the point a partition breaks,
  // nothing has been verified. Reporting a partial tally reads as a coverage
  // shortfall, which is exactly what a partition error is NOT.
  const out = run({
    roster: ["reviewer-1", "reviewer-2"],
    findings: {
      "reviewer-1": roleFile({ role: "reviewer-1", assigned_files: ["src/a.ts", "src/b.ts"], files_reviewed: ["src/a.ts", "src/b.ts"] }),
      "reviewer-2": roleFile({ role: "reviewer-2", assigned_files: ["src/b.ts"], files_reviewed: ["src/b.ts"] }),
    },
  });
  assert.equal(out.status, "inconclusive");
  assert.equal(out.coverage.reviewed_files, 0);
  assert.equal(out.coverage.expected_files, 2);
});

test("row 6: partition integrity — two roles must not be assigned the same file", () => {
  // The other half of §6 step 2, vacuous while the roster was size 1. Two roles
  // holding one path is not a coverage gap — the union still matches, and every
  // assertion above stays green — so it can only be caught here. It means the
  // roster was built wrong: the file is read twice, and one defect surfaces
  // under two ids that the deterministic dedupe cannot merge across roles when
  // the reported line or reason differs.
  const out = run({
    roster: ["reviewer-1", "reviewer-2"],
    findings: {
      "reviewer-1": roleFile({
        role: "reviewer-1",
        assigned_files: ["src/a.ts", "src/b.ts"],
        files_reviewed: ["src/a.ts", "src/b.ts"],
      }),
      "reviewer-2": roleFile({
        role: "reviewer-2",
        assigned_files: ["src/b.ts"],
        files_reviewed: ["src/b.ts"],
      }),
    },
  });
  assert.equal(out.status, "inconclusive");
  assert.match(out.reason, /partition/);
  assert.match(out.reason, /src\/b\.ts/);
});

test("row 6: disjoint roles that jointly cover changed_files pass", () => {
  const out = run({
    roster: ["reviewer-1", "reviewer-2"],
    findings: {
      "reviewer-1": roleFile({
        role: "reviewer-1",
        assigned_files: ["src/a.ts"],
        files_reviewed: ["src/a.ts"],
      }),
      "reviewer-2": roleFile({
        role: "reviewer-2",
        assigned_files: ["src/b.ts"],
        files_reviewed: ["src/b.ts"],
      }),
    },
  });
  assert.equal(out.status, "ok");
});

test("row 6: overlapping files_reviewed is fine — only assignment must be disjoint", () => {
  // Reading a neighbour file for context is exactly what a reviewer should do.
  // Only the assignment is a partition.
  const out = run({
    roster: ["reviewer-1", "reviewer-2"],
    findings: {
      "reviewer-1": roleFile({
        role: "reviewer-1",
        assigned_files: ["src/a.ts"],
        files_reviewed: ["src/a.ts", "src/b.ts"],
      }),
      "reviewer-2": roleFile({
        role: "reviewer-2",
        assigned_files: ["src/b.ts"],
        files_reviewed: ["src/b.ts", "src/a.ts"],
      }),
    },
  });
  assert.equal(out.status, "ok");
});

test("intent comes from the frame role, not from whichever role is listed first", () => {
  // §6 step 9 says intent is owned by exactly one role. Selecting on array
  // position made that false the moment the roster emitted coverage reviewers
  // before the frame role — and derive-findings.js stamps `intent` onto every
  // role file, so a reviewer that saw one slice of the diff and cannot judge the
  // PR's goal would shadow the role whose whole job that is. Fail-open in the
  // direction step 9 exists to close.
  const out = run({
    roster: ["reviewer-1", "intent"],
    findings: {
      "reviewer-1": roleFile({
        role: "reviewer-1",
        assigned_files: ["src/a.ts", "src/b.ts"],
        files_reviewed: ["src/a.ts", "src/b.ts"],
        intent: "aligned",
      }),
      intent: roleFile({
        role: "intent",
        assigned_files: [],
        files_reviewed: [],
        intent: "deviated",
      }),
    },
  });
  assert.equal(out.status, "ok");
  assert.equal(out.review.intent, "deviated");
});

test("intent falls back to any valid value when no frame role is rostered", () => {
  // The serial roster is a single `review-serial` role that owns intent itself.
  const out = run();
  assert.equal(out.status, "ok");
  assert.equal(out.review.intent, "aligned");
});

test("a rostered frame role with an unusable intent fails closed — no fallback", () => {
  // The previous version of this test set reviewer-1's intent to null too, so
  // it only pinned "inconclusive when EVERY role is invalid" and left the real
  // hole open: a garbled frame value fell through to whichever coverage role
  // answered first. reviewer-1 says `aligned` here deliberately.
  for (const bad of ["sideways", null, 42, ""]) {
    const out = run({
      roster: ["reviewer-1", "intent"],
      findings: {
        "reviewer-1": roleFile({
          role: "reviewer-1",
          assigned_files: ["src/a.ts", "src/b.ts"],
          files_reviewed: ["src/a.ts", "src/b.ts"],
          intent: "aligned",
        }),
        intent: roleFile({ role: "intent", assigned_files: [], files_reviewed: [], intent: bad }),
      },
    });
    assert.equal(out.status, "inconclusive", `frame intent ${JSON.stringify(bad)}`);
    assert.match(out.reason, /no-intent/);
  }
});

test("an intent file absent from the roster is never preferred over a rostered role", () => {
  // byRole is keyed by role name and can carry entries the roster never
  // declared. Those are never validated by malformed(), so preferring one would
  // route an unvalidated value straight into the verdict.
  const out = run({
    roster: ["review-serial"],
    findings: {
      "review-serial": roleFile({ intent: "deviated" }),
      intent: { schema: 1, role: "intent", intent: "aligned" },
    },
  });
  assert.equal(out.status, "ok");
  assert.equal(out.review.intent, "deviated");
});

test("checklist is owned by the frame role, not concatenated across roles", () => {
  // Same property the intent fix is about. derive-findings.js stamps `checklist`
  // onto every role file, so flatMap duplicates each item K times — and
  // publish.js counts verified items per normalized text precisely so one
  // verified item cannot tick several identically-normalizing boxes. Inflating
  // that count to K reopens the collision the counter exists to prevent.
  const item = { text: "Adds a test", status: "verified" };
  const out = run({
    roster: ["reviewer-1", "reviewer-2", "intent"],
    findings: {
      "reviewer-1": roleFile({ role: "reviewer-1", assigned_files: ["src/a.ts"], files_reviewed: ["src/a.ts"], checklist: [item] }),
      "reviewer-2": roleFile({ role: "reviewer-2", assigned_files: ["src/b.ts"], files_reviewed: ["src/b.ts"], checklist: [item] }),
      intent: roleFile({ role: "intent", assigned_files: [], files_reviewed: [], checklist: [item] }),
    },
  });
  assert.equal(out.status, "ok");
  assert.deepEqual(out.review.checklist, [item]);
});

test("checklist still concatenates when no frame role is rostered", () => {
  const item = { text: "Adds a test", status: "verified" };
  const out = run({ findings: { "review-serial": roleFile({ checklist: [item] }) } });
  assert.deepEqual(out.review.checklist, [item]);
});

test("row 8: a dead scorer is inconclusive even when nobody found anything", () => {
  // The guard was conditional on candidates.length > 0, so: scorer dies, every
  // coverage reviewer legitimately returns zero findings, the guard doesn't
  // fire, scoreList falls back to [], both set-equality loops iterate nothing,
  // and a clean verdict comes out of a run with a dead role. Every other dead
  // role is named by the roster loop; the scorer alone was exempt. Unreachable
  // today — action.yml null-checks scores.json first — but this is the PR that
  // puts a scorer on the roster with its own artifact path, which is what makes
  // it reachable at PR-D/2.
  for (const bad of [null, undefined, { schema: 1, role: "scorer", complete: false, scores: [] }]) {
    const out = run({ scores: bad });
    assert.equal(out.status, "inconclusive", String(bad));
    assert.match(out.reason, /scores/);
  }
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

test("§7a: thresholds are >=50 for P0/P1 and >=75 for P2/P3", () => {
  // 75, not 80: confidence is a 0/25/50/75/100 enum, so an 80 floor admitted
  // only 100 for P2/P3. See the CONFIDENCE_FLOOR comment.
  const cases = [
    ["P0", 50, true], ["P0", 49, false],
    ["P1", 50, true], ["P1", 49, false],
    ["P2", 75, true], ["P2", 74, false],
    ["P3", 75, true], ["P3", 74, false],
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

// --- finding-level validation ------------------------------------------------
//
// The envelope check is not enough. A finding with a garbage severity has no
// entry in CONFIDENCE_FLOOR, so `floor` is undefined and the entry is quietly
// routed to dropped[] — which is the "absence reads as clean" failure the
// module header says must never happen. It has to be inconclusive instead.

test("row 5: a finding with an unrecognised severity is malformed, not dropped", () => {
  for (const sev of [undefined, null, "", "P4", "critical", 1]) {
    const f = finding({ severity: sev });
    const out = run({
      findings: { "review-serial": roleFile({ findings: [f] }) },
      scores: scoresFor([f.id]),
    });
    assert.equal(out.status, "inconclusive", `severity=${String(sev)}`);
    assert.match(out.reason, /malformed/);
  }
});

test("row 5: a finding with no usable id is malformed", () => {
  for (const id of [undefined, null, "", 42]) {
    const out = run({
      findings: { "review-serial": roleFile({ findings: [finding({ id })] }) },
      scores: scoresFor([]),
    });
    assert.equal(out.status, "inconclusive", `id=${String(id)}`);
    assert.match(out.reason, /malformed/);
  }
});

test("a scorer severity_confirmed that is garbage does not silently downgrade", () => {
  const f = finding({ severity: "P1" });
  const out = run({
    findings: { "review-serial": roleFile({ findings: [f] }) },
    scores: scoresFor([f.id], {
      scores: [{ id: f.id, confidence: 90, severity_confirmed: "banana" }],
    }),
  });
  // Unusable scorer label must not weaken the finder's; P1 stands.
  assert.equal(out.status, "ok");
  assert.equal(out.review.counts.p1, 1);
});

// --- scorer-side validation --------------------------------------------------
//
// Symmetric to the finding-level checks. Without this, Number(undefined) is NaN
// and Number(null) is 0 — both take the drop branch — so a P0 the scorer
// CONFIRMED as P0 lands in dropped[], counts.p0 is 0, and recompute() returns
// pass. Reproduced before the fix: status ok, counts all zero, verdict pass.

test("row 5: a score entry with no usable confidence is malformed, not a silent drop", () => {
  for (const conf of [undefined, null, "", "high", NaN]) {
    const f = finding({ severity: "P0" });
    const out = run({
      findings: { "review-serial": roleFile({ findings: [f] }) },
      scores: scoresFor([f.id], {
        scores: [{ id: f.id, confidence: conf, severity_confirmed: "P0" }],
      }),
    });
    assert.equal(out.status, "inconclusive", `confidence=${String(conf)}`);
    assert.match(out.reason, /malformed|score/);
  }
});

test("row 5: a score entry with no usable id is malformed", () => {
  const f = finding();
  const out = run({
    findings: { "review-serial": roleFile({ findings: [f] }) },
    scores: scoresFor([f.id], {
      scores: [{ id: null, confidence: 90, severity_confirmed: "P1" }],
    }),
  });
  assert.equal(out.status, "inconclusive");
  assert.match(out.reason, /malformed|score/);
});

test("a confirmed P0 with a missing confidence can NEVER produce a pass", () => {
  const f = finding({ severity: "P0" });
  const out = run({
    findings: { "review-serial": roleFile({ findings: [f] }) },
    scores: scoresFor([f.id], {
      scores: [{ id: f.id, severity_confirmed: "P0", rationale: "real" }],
    }),
  });
  assert.equal(out.status, "inconclusive");
  assert.equal(out.review, null);
});

// --- duplicate ids -----------------------------------------------------------
//
// The schema does not require id uniqueness and the model invents the ids.
// scoreById is a Map (last wins) and the join asserts SET equality, which is
// duplicate-blind — so two findings sharing an id both take the last score.
// Reproduced before the fix: a P0 at confidence 100 colliding with a P3 at 25
// produced counts {p0:0,...}, status ok, verdict PASS.

test("row 5: duplicate finding ids are malformed, never a silent collapse", () => {
  const dup = [finding({ id: "f1", severity: "P0" }), finding({ id: "f1", severity: "P3" })];
  const out = run({
    findings: { "review-serial": roleFile({ findings: dup }) },
    scores: scoresFor([], {
      scores: [
        { id: "f1", confidence: 100, severity_confirmed: "P0" },
        { id: "f1", confidence: 25, severity_confirmed: "P3" },
      ],
    }),
  });
  assert.equal(out.status, "inconclusive");
  assert.match(out.reason, /duplicate/);
});

test("a colliding P0 can NEVER be laundered into a pass", () => {
  const dup = [finding({ id: "f1", severity: "P0" }), finding({ id: "f1", severity: "P3" })];
  const out = run({
    findings: { "review-serial": roleFile({ findings: dup }) },
    scores: scoresFor([], {
      scores: [
        { id: "f1", confidence: 100, severity_confirmed: "P0" },
        { id: "f1", confidence: 25, severity_confirmed: "P3" },
      ],
    }),
  });
  assert.equal(out.review, null);
});

test("row 5: duplicate score ids are malformed too", () => {
  const f = finding({ id: "f1" });
  const out = run({
    findings: { "review-serial": roleFile({ findings: [f] }) },
    scores: scoresFor([], {
      scores: [
        { id: "f1", confidence: 90, severity_confirmed: "P1" },
        { id: "f1", confidence: 25, severity_confirmed: "P3" },
      ],
    }),
  });
  assert.equal(out.status, "inconclusive");
  assert.match(out.reason, /duplicate/);
});

// --- threshold granularity ---------------------------------------------------

test("§7a floors land ON rungs of the 0/25/50/75/100 confidence enum", () => {
  const { CONFIDENCE_FLOOR } = require("./aggregate.js");
  const ENUM = [0, 25, 50, 75, 100];
  for (const [sev, floor] of Object.entries(CONFIDENCE_FLOOR)) {
    assert.ok(ENUM.includes(floor), `${sev} floor ${floor} is not an admissible confidence`);
  }
});

test("a P2 at 75 now survives; at 50 it still drops", () => {
  for (const [conf, keep] of [[75, true], [50, false]]) {
    const f = finding({ severity: "P2" });
    const out = run({
      findings: { "review-serial": roleFile({ findings: [f] }) },
      scores: scoresFor([f.id], {
        scores: [{ id: f.id, confidence: conf, severity_confirmed: "P2" }],
      }),
    });
    assert.equal(out.kept.length, keep ? 1 : 0, `P2@${conf}`);
  }
});

// --- coverage diagnostics ----------------------------------------------------

test("partial files_reviewed no longer fails closed (/code-review reads)", () => {
  const out = run({
    findings: { "review-serial": roleFile({ files_reviewed: ["src/a.ts"] }) },
  });
  assert.equal(out.status, "ok");
  assert.equal(out.reason, null);
  assert.equal(out.coverage.reviewed_files, 1);
});

test("a leading ./ on a model-typed path is not a coverage failure", () => {
  const out = run({
    findings: {
      "review-serial": roleFile({ files_reviewed: ["./src/a.ts", "src/b.ts"] }),
    },
  });
  assert.equal(out.status, "ok");
});
