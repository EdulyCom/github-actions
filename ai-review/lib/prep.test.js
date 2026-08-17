"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseNumstat,
  extractSymbols,
  isConventionalTitle,
  classifyPaths,
  buildManifest,
} = require("./prep.js");

// --- parseNumstat ------------------------------------------------------------
//
// Input is `git diff --numstat <base>...HEAD`: tab-separated added/removed/path.
// The action already routes on files/churn derived this way; moving the parse
// into a tested module is the point of PR-B, so the numbers the model is handed
// are ones a test pins rather than ones a shell one-liner produced.

test("parseNumstat: counts files and churn", () => {
  const out = parseNumstat("3\t1\tsrc/a.ts\n10\t2\tsrc/b.ts");
  assert.equal(out.fileCount, 2);
  assert.equal(out.churn, 16);
  assert.deepEqual(
    out.files.map((f) => f.path),
    ["src/a.ts", "src/b.ts"],
  );
});

test("parseNumstat: empty diff yields zero, not NaN", () => {
  for (const empty of ["", "   ", "\n"]) {
    const out = parseNumstat(empty);
    assert.equal(out.fileCount, 0);
    assert.equal(out.churn, 0);
    assert.deepEqual(out.files, []);
  }
});

test("parseNumstat: binary rows count as zero churn but still count as files", () => {
  // git emits "-\t-\tpath" for binary files. action.yml's awk coerced these to
  // 0; that behaviour is deliberate and preserved here so routing does not
  // change under this refactor.
  const out = parseNumstat("-\t-\tassets/logo.png\n5\t0\tsrc/a.ts");
  assert.equal(out.fileCount, 2);
  assert.equal(out.churn, 5);
  assert.equal(out.files[0].binary, true);
  assert.equal(out.files[1].binary, false);
});

test("parseNumstat: handles both rename spellings", () => {
  const out = parseNumstat(
    "1\t1\tsrc/{old => new}/a.ts\n2\t0\tlib/old.ts => lib/new.ts",
  );
  assert.deepEqual(
    out.files.map((f) => f.path),
    ["src/new/a.ts", "lib/new.ts"],
  );
});

test("parseNumstat: tolerates trailing newline and CRLF", () => {
  const out = parseNumstat("3\t1\tsrc/a.ts\r\n10\t2\tsrc/b.ts\r\n");
  assert.equal(out.fileCount, 2);
  assert.equal(out.churn, 16);
  assert.equal(out.files[1].path, "src/b.ts");
});

// --- extractSymbols ----------------------------------------------------------
//
// Regex-grade extraction from hunk headers. `git diff -U0` puts the enclosing
// context after the second `@@`, which is where function/class names appear.
// This is deliberately not a parser: the tracer role in the parallel design
// needs a list of candidate symbols to chase, not a compiler-accurate AST.

test("extractSymbols: pulls names out of hunk header context", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,4 @@ export function authorize(user: User) {",
    "+  const x = 1;",
  ].join("\n");
  const syms = extractSymbols(diff);
  assert.equal(syms.length, 1);
  assert.equal(syms[0].file, "src/a.ts");
  assert.equal(syms[0].name, "authorize");
});

test("extractSymbols: attributes symbols to the right file across hunks", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "@@ -1,2 +1,3 @@ function alpha() {",
    "diff --git a/src/b.ts b/src/b.ts",
    "@@ -4,2 +4,3 @@ class Beta {",
  ].join("\n");
  const syms = extractSymbols(diff);
  assert.deepEqual(
    syms.map((s) => [s.file, s.name]),
    [
      ["src/a.ts", "alpha"],
      ["src/b.ts", "Beta"],
    ],
  );
});

test("extractSymbols: no hunk context yields no symbols, not a crash", () => {
  const diff = [
    "diff --git a/README.md b/README.md",
    "@@ -1,2 +1,3 @@",
    "+text",
  ].join("\n");
  assert.deepEqual(extractSymbols(diff), []);
});

test("extractSymbols: deduplicates a symbol touched by several hunks", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "@@ -10,3 +10,4 @@ export function authorize(user: User) {",
    "@@ -40,3 +40,4 @@ export function authorize(user: User) {",
  ].join("\n");
  assert.equal(extractSymbols(diff).length, 1);
});

test("extractSymbols: empty input is safe", () => {
  assert.deepEqual(extractSymbols(""), []);
  assert.deepEqual(extractSymbols(null), []);
});

// --- isConventionalTitle -----------------------------------------------------
//
// rubric.md requires a Conventional-Commits PR title. Today that is a model
// judgment; the spec (§3) makes it deterministic. Aggregation injects a P2 when
// this returns false, so a false positive here silently weakens the gate.

test("isConventionalTitle: accepts the documented forms", () => {
  for (const ok of [
    "feat: add thing",
    "fix(ai-review): bound the stall",
    "docs: update readme",
    "refactor(lib)!: drop the old shape",
    "chore(deps): bump action",
    "perf!: make it fast",
  ]) {
    assert.equal(isConventionalTitle(ok), true, ok);
  }
});

test("isConventionalTitle: rejects malformed titles", () => {
  for (const bad of [
    "add thing",
    "Fix: capitalised type",
    "feat add thing",
    "feat:",
    "feat:   ",
    "",
    null,
    undefined,
    "unknowntype: something",
  ]) {
    assert.equal(isConventionalTitle(bad), false, String(bad));
  }
});

// --- classifyPaths -----------------------------------------------------------
//
// `no_tests_for_changed_logic` is worth -15 in recompute.js and is currently a
// model judgment. Spec §3 makes it pure path classification.

test("classifyPaths: logic change without a test change", () => {
  const c = classifyPaths(["src/auth.ts", "src/util.ts"]);
  assert.equal(c.hasLogicChange, true);
  assert.equal(c.hasTestChange, false);
  assert.equal(c.noTestsForChangedLogic, true);
});

test("classifyPaths: recognises common test path spellings", () => {
  for (const p of [
    "src/a.test.ts",
    "src/a.spec.js",
    "test/a.py",
    "tests/a.py",
    "__tests__/a.tsx",
    "src/a_test.go",
    "spec/models/a_spec.rb",
  ]) {
    assert.equal(classifyPaths([p]).hasTestChange, true, p);
  }
});

test("classifyPaths: docs-only change is not a logic change", () => {
  const c = classifyPaths(["README.md", "docs/adr/0001.md"]);
  assert.equal(c.hasLogicChange, false);
  assert.equal(c.noTestsForChangedLogic, false);
});

test("classifyPaths: flags edits to reviewer-facing guidance", () => {
  assert.equal(classifyPaths(["CLAUDE.md"]).modifiesReviewerGuidance, true);
  assert.equal(
    classifyPaths([".claude/review-profile.md"]).modifiesReviewerGuidance,
    true,
  );
  assert.equal(classifyPaths(["src/a.ts"]).modifiesReviewerGuidance, false);
});

test("classifyPaths: empty input is safe", () => {
  const c = classifyPaths([]);
  assert.equal(c.hasLogicChange, false);
  assert.equal(c.hasTestChange, false);
  assert.equal(c.noTestsForChangedLogic, false);
});

// --- buildManifest -----------------------------------------------------------
//
// The artifact the review prompt is told to trust. Its schema is frozen by the
// parallel-review spec §6 so PR-D can consume it unchanged.

test("buildManifest: assembles the frozen shape", () => {
  const m = buildManifest({
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    numstat: "3\t1\tsrc/a.ts\n0\t0\tsrc/a.test.ts",
    diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1,2 +1,3 @@ function alpha() {",
    sizes: { "src/a.ts": 120, "src/a.test.ts": 80 },
    title: "feat: add alpha",
  });

  assert.equal(m.schema, 1);
  assert.equal(m.base_sha, "a".repeat(40));
  assert.equal(m.head_sha, "b".repeat(40));
  assert.equal(m.review_mode, "full");
  assert.equal(m.delta_base_sha, null);
  assert.equal(m.prior_head_sha, null);
  assert.deepEqual(m.changed_files, ["src/a.ts", "src/a.test.ts"]);
  assert.equal(m.file_count, 2);
  assert.equal(m.churn, 4);
  assert.equal(m.total_fullfile_bytes, 200);
  assert.equal(m.title_ok, true);
  assert.equal(m.has_test_change, true);
  assert.equal(m.has_logic_change, true);
  assert.equal(m.no_tests_for_changed_logic, false);
  assert.equal(m.symbol_manifest[0].name, "alpha");
});

test("buildManifest: delta mode keeps merge-base telemetry but lists only delta-range files", () => {
  const prior = "c".repeat(40);
  // numstat already scoped to prior…HEAD by the prep step — only the file
  // touched after the last review appears, not the full PR set.
  const m = buildManifest({
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    numstat: "2\t0\tsrc/only-delta.ts\n",
    diff: "diff --git a/src/only-delta.ts b/src/only-delta.ts\n@@ -0,0 +1 @@ function deltaOnly() {",
    sizes: { "src/only-delta.ts": 40 },
    title: "fix: tighten delta",
    reviewMode: "delta",
    deltaBaseSha: prior,
    priorHeadSha: prior,
  });

  assert.equal(m.review_mode, "delta");
  assert.equal(m.base_sha, "a".repeat(40));
  assert.equal(m.delta_base_sha, prior);
  assert.equal(m.prior_head_sha, prior);
  assert.deepEqual(m.changed_files, ["src/only-delta.ts"]);
  assert.equal(m.file_count, 1);
  assert.equal(m.symbol_manifest[0].name, "deltaOnly");
});

test("buildManifest: missing size entries do not produce NaN", () => {
  const m = buildManifest({
    baseSha: "a",
    headSha: "b",
    numstat: "1\t0\tsrc/a.ts",
    diff: "",
    sizes: {},
    title: "fix: x",
  });
  assert.equal(m.total_fullfile_bytes, 0);
  assert.equal(Number.isNaN(m.total_fullfile_bytes), false);
});

test("buildManifest: empty diff is representable and flagged", () => {
  const m = buildManifest({
    baseSha: "a",
    headSha: "b",
    numstat: "",
    diff: "",
    sizes: {},
    title: "chore: noop",
  });
  assert.equal(m.file_count, 0);
  assert.deepEqual(m.changed_files, []);
  assert.equal(m.empty_diff, true);
});

test("buildManifest: output is JSON-serialisable and stable", () => {
  const args = {
    baseSha: "a",
    headSha: "b",
    numstat: "1\t0\tsrc/a.ts",
    diff: "",
    sizes: { "src/a.ts": 10 },
    title: "fix: x",
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(buildManifest(args))),
    JSON.parse(JSON.stringify(buildManifest(args))),
  );
});
