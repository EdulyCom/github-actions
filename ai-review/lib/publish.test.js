"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  stripLeadingBannerArtifacts,
  buildReviewBody,
  buildInconclusiveBody,
  tickVerifiedBoxes,
  buildStatusBlock,
  upsertStatusBlock,
} = require("./publish.js");

// --- stripLeadingBannerArtifacts --------------------------------------------

test("unescapes literal \\\\n when comment_markdown was double-escaped", () => {
  // Observed on PR #52 review 4949356509: model/schema path left `\\n` as
  // two characters, so GitHub rendered the body as one smashed line.
  const raw =
    "### P0 — Blockers\\n\\n_None._\\n\\n### P1 — Should Fix\\n\\n_None._\\n\\n### P2 — Nice-to-Have\\n\\n- drift risk";
  const out = stripLeadingBannerArtifacts(raw);
  assert.equal(
    out,
    [
      "### P0 — Blockers",
      "",
      "_None._",
      "",
      "### P1 — Should Fix",
      "",
      "_None._",
      "",
      "### P2 — Nice-to-Have",
      "",
      "- drift risk",
    ].join("\n")
  );
  assert.equal(out.includes("\\n"), false);
});

test("leaves normal markdown with real newlines alone", () => {
  const raw = "### P0 — Blockers\n\n_None._\n\nUse `\\\\n` in a code span occasionally.";
  const out = stripLeadingBannerArtifacts(raw);
  assert.equal(out, raw);
});

test("strips a leading verdict token line", () => {
  const out = stripLeadingBannerArtifacts("**✅ PASS**\n\nReal content here.");
  assert.equal(out, "Real content here.");
});

test("strips a leading confidence/merge-risk line", () => {
  const out = stripLeadingBannerArtifacts(
    "Confidence: 90 · Merge risk: low\nReal content here."
  );
  assert.equal(out, "Real content here.");
});

test("strips a leading HTML comment", () => {
  const out = stripLeadingBannerArtifacts("<!-- ai-review -->\nReal content here.");
  assert.equal(out, "Real content here.");
});

test("strips multiple leading artifacts and blank lines together", () => {
  const out = stripLeadingBannerArtifacts(
    "<!-- ai-review -->\n**❌ FAIL**\n\nConfidence: 40 · Merge risk: high\n\nReal content here."
  );
  assert.equal(out, "Real content here.");
});

test("leaves real content with no leading artifacts untouched", () => {
  const out = stripLeadingBannerArtifacts("### P0 — Blockers\n\n_None._");
  assert.equal(out, "### P0 — Blockers\n\n_None._");
});

test("returns falsy input as-is", () => {
  assert.equal(stripLeadingBannerArtifacts(""), "");
  assert.equal(stripLeadingBannerArtifacts(null), null);
  assert.equal(stripLeadingBannerArtifacts(undefined), undefined);
});

// --- buildReviewBody ---------------------------------------------------------

const BASE_ARGS = {
  verdict: "pass",
  confidence: 95,
  mergeRisk: "low",
  counts: { p0: 0, p1: 0, p2: 0, p3: 0 },
  intentDeviated: false,
  modelVerdict: "pass",
  blockers: [],
  commentBody: "### Strengths\n\nClean diff.",
};

test("pass verdict with no P2/P3 has no advisory note and no rejected banner", () => {
  const body = buildReviewBody(BASE_ARGS);
  assert.match(body, /\*\*✅ PASS\*\*/);
  assert.doesNotMatch(body, /non-blocking/);
  assert.doesNotMatch(body, /Rejected/);
});

test("pass verdict with P2/P3 findings includes the advisory note", () => {
  const body = buildReviewBody({
    ...BASE_ARGS,
    counts: { p0: 0, p1: 0, p2: 2, p3: 1 },
  });
  assert.match(body, /2 P2 \/ 1 P3 finding\(s\) noted — non-blocking\./);
});

test("fail verdict with blockers includes the reason note", () => {
  const body = buildReviewBody({
    ...BASE_ARGS,
    verdict: "fail",
    modelVerdict: "fail",
    blockers: ["1 P0 blocker", "2 P1 findings"],
  });
  assert.match(body, /\*\*❌ FAIL\*\*/);
  assert.match(body, /Why the gate failed:\*\* 1 P0 blocker; 2 P1 findings\./);
});

test("intentDeviated adds the rejected banner ahead of the verdict line", () => {
  const body = buildReviewBody({ ...BASE_ARGS, intentDeviated: true });
  assert.match(body, /❌ \*\*Rejected — wrong solution\*\*\n\n\*\*✅ PASS\*\*/);
});

test("a model/deterministic verdict mismatch is noted", () => {
  const body = buildReviewBody({
    ...BASE_ARGS,
    verdict: "fail",
    modelVerdict: "pass",
    blockers: ["1 P1 finding"],
  });
  assert.match(
    body,
    /Deterministic recomputation \(\*\*fail\*\*\) overrides the model's self-reported verdict \(\*\*pass\*\*\)\./
  );
});

test("no mismatch note when the model verdict agrees", () => {
  const body = buildReviewBody(BASE_ARGS);
  assert.doesNotMatch(body, /overrides the model's self-reported verdict/);
});

test("an empty comment body falls back to a placeholder", () => {
  const body = buildReviewBody({ ...BASE_ARGS, commentBody: "" });
  assert.match(body, /_No review content returned\._/);
});

test("always leads with the <!-- ai-review --> marker", () => {
  const body = buildReviewBody(BASE_ARGS);
  assert.match(body, /^<!-- ai-review -->\n/);
});

test("buildReviewBody omits Model line but keeps re-review hint", () => {
  const body = buildReviewBody({
    ...BASE_ARGS,
    modelUsed: "claude/claude-sonnet-5",
  });
  assert.doesNotMatch(body, /^Model:/m);
  assert.doesNotMatch(body, /Model: `claude\/claude-sonnet-5`/);
  assert.match(body, /Re-run this job if you need another review pass/);
});

test("buildReviewBody still omits Model line when modelUsed is empty", () => {
  const body = buildReviewBody({ ...BASE_ARGS, modelUsed: "" });
  assert.doesNotMatch(body, /^Model:/m);
  assert.match(body, /Re-run this job if you need another review pass/);
});

test("buildReviewBody stamps ai-review-meta immediately after the marker", () => {
  const body = buildReviewBody({
    ...BASE_ARGS,
    reviewMeta: {
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      mode: "delta",
    },
  });
  assert.match(
    body,
    /^<!-- ai-review -->\n<!-- ai-review-meta head_sha=a{40} base_sha=b{40} mode=delta -->\n/
  );
});

test("buildReviewBody omits meta when reviewMeta is absent", () => {
  const body = buildReviewBody(BASE_ARGS);
  assert.doesNotMatch(body, /ai-review-meta/);
});

// --- buildInconclusiveBody ---------------------------------------------------

test("without salvaged text there is no details block", () => {
  const body = buildInconclusiveBody("");
  assert.match(body, /inconclusive \(re-run required\)/);
  assert.doesNotMatch(body, /<details>/);
});

test("with salvaged text the details block contains it", () => {
  const body = buildInconclusiveBody("The diff looked fine but I ran out of turns.");
  assert.match(body, /<details><summary>Unstructured model output recovered/);
  assert.match(body, /The diff looked fine but I ran out of turns\./);
  assert.match(body, /<\/details>/);
});

test("buildInconclusiveBody omits Model line and keeps job re-run instruction", () => {
  const body = buildInconclusiveBody("salvaged text", {
    modelUsed: "claude/cursor/composer-2.5",
  });
  assert.doesNotMatch(body, /Model: `claude\/cursor\/composer-2.5`/);
  assert.doesNotMatch(body, /^Model:/m);
  assert.match(body, /\*\*Re-run the `ai-review` job\*\*/);
  assert.doesNotMatch(body, /_Re-run this job if you need another review pass\._/);
});

test("buildInconclusiveBody stamps meta with mode=inconclusive", () => {
  const body = buildInconclusiveBody("", {
    reviewMeta: {
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  });
  assert.match(
    body,
    /^<!-- ai-review -->\n<!-- ai-review-meta head_sha=a{40} base_sha=b{40} mode=inconclusive -->\n/
  );
});

// --- tickVerifiedBoxes --------------------------------------------------------

test("ticks a single matching unchecked box", () => {
  const { newBody, ticks } = tickVerifiedBoxes(
    "- [ ] Handles empty input\n- [ ] Logs errors",
    [{ text: "Handles empty input", status: "verified" }]
  );
  assert.equal(newBody, "- [x] Handles empty input\n- [ ] Logs errors");
  assert.equal(ticks, 1);
});

test("does not tick a box for a failed or unverifiable item", () => {
  const { newBody, ticks } = tickVerifiedBoxes("- [ ] Handles empty input", [
    { text: "Handles empty input", status: "failed" },
  ]);
  assert.equal(newBody, "- [ ] Handles empty input");
  assert.equal(ticks, 0);
});

test("never unticks an already-checked box", () => {
  // The checkbox regex only matches "[ ]" — an already-ticked "[x]" line is
  // never touched, regardless of what the checklist says about it.
  const { newBody, ticks } = tickVerifiedBoxes("- [x] Handles empty input", [
    { text: "Handles empty input", status: "failed" },
  ]);
  assert.equal(newBody, "- [x] Handles empty input");
  assert.equal(ticks, 0);
});

test("over-tick collision: ticks at most as many boxes as verified items with that text", () => {
  const { newBody, ticks } = tickVerifiedBoxes(
    "- [ ] Handles empty input\n- [ ] Handles empty input\n- [ ] Handles empty input",
    [{ text: "Handles empty input", status: "verified" }]
  );
  assert.equal(
    newBody,
    "- [x] Handles empty input\n- [ ] Handles empty input\n- [ ] Handles empty input"
  );
  assert.equal(ticks, 1);
});

test("normalizes markdown formatting differences between checklist and PR body text", () => {
  const { newBody, ticks } = tickVerifiedBoxes("- [ ] **Handles** `empty` input.", [
    { text: "Handles empty input", status: "verified" },
  ]);
  assert.equal(newBody, "- [x] **Handles** `empty` input.");
  assert.equal(ticks, 1);
});

test("zero ticks when nothing in the checklist is verified", () => {
  const { newBody, ticks } = tickVerifiedBoxes("- [ ] Handles empty input", []);
  assert.equal(newBody, "- [ ] Handles empty input");
  assert.equal(ticks, 0);
});

// --- buildStatusBlock ---------------------------------------------------------

test("renders the correct icon per checklist status", () => {
  const block = buildStatusBlock({
    checklist: [
      { text: "A", status: "verified" },
      { text: "B", status: "failed" },
      { text: "C", status: "unverifiable" },
    ],
    verificationEvidence: [],
    verdict: "pass",
  });
  assert.match(block, /✅ A/);
  assert.match(block, /❌ B/);
  assert.match(block, /❔ C/);
});

test("includes an item's evidence only when present", () => {
  const block = buildStatusBlock({
    checklist: [
      { text: "A", status: "verified", evidence: "ran the test suite" },
      { text: "B", status: "verified" },
    ],
    verificationEvidence: [],
    verdict: "pass",
  });
  assert.match(block, /✅ A — ran the test suite/);
  assert.match(block, /✅ B\n/);
});

test("includes the verification-evidence section only when there is evidence", () => {
  const withEvidence = buildStatusBlock({
    checklist: [{ text: "A", status: "verified" }],
    verificationEvidence: [{ command: "npm test", result: "0 failures" }],
    verdict: "pass",
  });
  assert.match(withEvidence, /_Verification evidence:_/);
  assert.match(withEvidence, /`npm test` → 0 failures/);

  const withoutEvidence = buildStatusBlock({
    checklist: [{ text: "A", status: "verified" }],
    verificationEvidence: [],
    verdict: "pass",
  });
  assert.doesNotMatch(withoutEvidence, /_Verification evidence:_/);
});

test("closing line names the verdict", () => {
  const block = buildStatusBlock({
    checklist: [{ text: "A", status: "verified" }],
    verificationEvidence: [],
    verdict: "fail",
  });
  assert.match(block, /_Last updated by ai-review · verdict: fail\._/);
});

// --- upsertStatusBlock ---------------------------------------------------------

test("replaces an existing status block in place", () => {
  const body = [
    "Some PR description.",
    "",
    "<!-- ai-review-status -->",
    "old content",
    "<!-- /ai-review-status -->",
    "",
    "Trailing text.",
  ].join("\n");
  const newBody = upsertStatusBlock(body, "<!-- ai-review-status -->\nnew content\n<!-- /ai-review-status -->");
  assert.match(newBody, /new content/);
  assert.doesNotMatch(newBody, /old content/);
  assert.match(newBody, /Trailing text\./);
});

test("appends a new status block when none exists, trimming trailing whitespace first", () => {
  const body = "Some PR description.\n\n\n";
  const newBody = upsertStatusBlock(body, "<!-- ai-review-status -->\ncontent\n<!-- /ai-review-status -->");
  assert.equal(
    newBody,
    "Some PR description.\n\n<!-- ai-review-status -->\ncontent\n<!-- /ai-review-status -->\n"
  );
});
