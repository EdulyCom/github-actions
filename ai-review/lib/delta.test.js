"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseReviewMeta,
  formatReviewMeta,
  resolveReviewRange,
  findLatestAiReview,
  resolveDeltaBaseline,
} = require("./delta.js");

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PRIOR = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BASE = "cccccccccccccccccccccccccccccccccccccccc";
const BASE2 = "dddddddddddddddddddddddddddddddddddddddd";

// --- formatReviewMeta / parseReviewMeta ------------------------------------

test("formatReviewMeta emits the frozen HTML comment shape", () => {
  assert.equal(
    formatReviewMeta({ headSha: HEAD, baseSha: BASE, mode: "full" }),
    `<!-- ai-review-meta head_sha=${HEAD} base_sha=${BASE} mode=full -->`
  );
  assert.equal(
    formatReviewMeta({ headSha: HEAD, baseSha: BASE, mode: "delta" }),
    `<!-- ai-review-meta head_sha=${HEAD} base_sha=${BASE} mode=delta -->`
  );
});

test("formatReviewMeta omits mode when absent (inconclusive-capable)", () => {
  assert.equal(
    formatReviewMeta({ headSha: HEAD, baseSha: BASE }),
    `<!-- ai-review-meta head_sha=${HEAD} base_sha=${BASE} -->`
  );
});

test("parseReviewMeta round-trips a formatted marker", () => {
  const line = formatReviewMeta({ headSha: HEAD, baseSha: BASE, mode: "delta" });
  const body = `<!-- ai-review -->\n${line}\n**✅ PASS**\n`;
  assert.deepEqual(parseReviewMeta(body), {
    headSha: HEAD,
    baseSha: BASE,
    mode: "delta",
  });
});

test("parseReviewMeta returns null for missing or garbage meta", () => {
  assert.equal(parseReviewMeta(null), null);
  assert.equal(parseReviewMeta(""), null);
  assert.equal(parseReviewMeta("<!-- ai-review -->\n**✅ PASS**"), null);
  assert.equal(parseReviewMeta("<!-- ai-review-meta broken -->"), null);
});

test("parseReviewMeta accepts mode-less meta (mode null)", () => {
  const body = `<!-- ai-review-meta head_sha=${HEAD} base_sha=${BASE} -->`;
  assert.deepEqual(parseReviewMeta(body), {
    headSha: HEAD,
    baseSha: BASE,
    mode: null,
  });
});

// --- resolveReviewRange ----------------------------------------------------

const rangeArgs = (over = {}) => ({
  priorMeta: { headSha: PRIOR, baseSha: BASE, mode: "full" },
  headSha: HEAD,
  mergeBaseSha: BASE,
  priorHeadIsAncestor: true,
  ...over,
});

test("resolveReviewRange: valid prior → delta from prior head to current HEAD", () => {
  assert.deepEqual(resolveReviewRange(rangeArgs()), {
    mode: "delta",
    baseSha: PRIOR,
    headSha: HEAD,
    reason: "prior-meta-ancestor",
  });
});

test("resolveReviewRange: missing meta → full from merge-base", () => {
  assert.deepEqual(resolveReviewRange(rangeArgs({ priorMeta: null })), {
    mode: "full",
    baseSha: BASE,
    headSha: HEAD,
    reason: "missing-or-unparseable-meta",
  });
});

test("resolveReviewRange: inconclusive prior → full", () => {
  assert.equal(
    resolveReviewRange(
      rangeArgs({ priorMeta: { headSha: PRIOR, baseSha: BASE, mode: "inconclusive" } })
    ).reason,
    "prior-inconclusive"
  );
  assert.equal(
    resolveReviewRange(
      rangeArgs({ priorMeta: { headSha: PRIOR, baseSha: BASE, mode: null } })
    ).reason,
    "prior-inconclusive"
  );
});

test("resolveReviewRange: base SHA mismatch (strict) → full", () => {
  const out = resolveReviewRange(rangeArgs({ mergeBaseSha: BASE2 }));
  assert.equal(out.mode, "full");
  assert.equal(out.baseSha, BASE2);
  assert.equal(out.reason, "base-sha-changed");
});

test("resolveReviewRange: prior head not ancestor → full", () => {
  assert.equal(
    resolveReviewRange(rangeArgs({ priorHeadIsAncestor: false })).reason,
    "prior-head-not-ancestor"
  );
  assert.equal(
    resolveReviewRange(rangeArgs({ priorHeadIsAncestor: undefined })).reason,
    "prior-head-not-ancestor"
  );
});

test("resolveReviewRange: forceFull → full", () => {
  assert.equal(resolveReviewRange(rangeArgs({ forceFull: true })).reason, "force-full-review");
});

// --- findLatestAiReview / resolveDeltaBaseline -----------------------------

test("findLatestAiReview picks the newest body with <!-- ai-review -->", () => {
  const latest = findLatestAiReview([
    {
      id: 1,
      submitted_at: "2026-01-01T00:00:00Z",
      body: "<!-- ai-review -->\nold",
    },
    {
      id: 2,
      submitted_at: "2026-06-01T00:00:00Z",
      body: `<!-- ai-review -->\n${formatReviewMeta({ headSha: PRIOR, baseSha: BASE, mode: "full" })}\n`,
    },
    { id: 3, submitted_at: "2026-07-01T00:00:00Z", body: "human comment" },
  ]);
  assert.equal(latest.id, 2);
});

test("resolveDeltaBaseline: no prior → full / no-prior-review", () => {
  assert.deepEqual(
    resolveDeltaBaseline({
      reviews: [],
      headSha: HEAD,
      mergeBaseSha: BASE,
    }),
    {
      mode: "full",
      deltaBaseSha: null,
      priorHeadSha: null,
      priorBody: null,
      reason: "no-prior-review",
    }
  );
});

test("resolveDeltaBaseline: valid meta + ancestor → delta", () => {
  const body = [
    "<!-- ai-review -->",
    formatReviewMeta({ headSha: PRIOR, baseSha: BASE, mode: "full" }),
    "**✅ PASS**",
  ].join("\n");
  const out = resolveDeltaBaseline({
    reviews: [{ id: 1, submitted_at: "2026-06-01T00:00:00Z", body }],
    headSha: HEAD,
    mergeBaseSha: BASE,
    priorHeadIsAncestor: true,
  });
  assert.deepEqual(out, {
    mode: "delta",
    deltaBaseSha: PRIOR,
    priorHeadSha: PRIOR,
    priorBody: body,
    reason: "prior-meta-ancestor",
  });
});

test("resolveDeltaBaseline: marker without meta → full", () => {
  const body = "<!-- ai-review -->\n**✅ PASS**";
  const out = resolveDeltaBaseline({
    reviews: [{ id: 1, submitted_at: "2026-06-01T00:00:00Z", body }],
    headSha: HEAD,
    mergeBaseSha: BASE,
    priorHeadIsAncestor: true,
  });
  assert.equal(out.mode, "full");
  assert.equal(out.reason, "missing-or-unparseable-meta");
  assert.equal(out.priorBody, body);
});

test("resolveDeltaBaseline: base change → full even when ancestor", () => {
  const body = [
    "<!-- ai-review -->",
    formatReviewMeta({ headSha: PRIOR, baseSha: BASE, mode: "delta" }),
  ].join("\n");
  const out = resolveDeltaBaseline({
    reviews: [{ id: 1, submitted_at: "2026-06-01T00:00:00Z", body }],
    headSha: HEAD,
    mergeBaseSha: BASE2,
    priorHeadIsAncestor: true,
  });
  assert.equal(out.mode, "full");
  assert.equal(out.reason, "base-sha-changed");
  assert.equal(out.priorHeadSha, PRIOR);
});
