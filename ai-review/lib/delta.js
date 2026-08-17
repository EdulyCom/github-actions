"use strict";

// Delta baseline for re-runs (spec §6 / frozen §10).
//
// Published review bodies carry:
//   <!-- ai-review -->
//   <!-- ai-review-meta head_sha=… base_sha=… mode=full|delta|inconclusive -->
//
// Prep (Task 3) will walk prior bot reviews, parse that meta, and decide
// full vs delta. This module is pure: no git, no GitHub I/O. The caller
// supplies whether prior head is an ancestor of current HEAD.

const AI_REVIEW_MARKER = "<!-- ai-review -->";

// Exact key order matches the frozen format in the design spec.
const META_RE =
  /<!--\s*ai-review-meta\s+head_sha=(\S+)\s+base_sha=(\S+)(?:\s+mode=(\S+))?\s*-->/;

/**
 * @param {string|null|undefined} body
 * @returns {{ headSha: string, baseSha: string, mode: string|null } | null}
 */
function parseReviewMeta(body) {
  if (typeof body !== "string" || !body.includes("ai-review-meta")) return null;
  const m = body.match(META_RE);
  if (!m) return null;
  const headSha = m[1];
  const baseSha = m[2];
  const mode = m[3] || null;
  if (!headSha || !baseSha) return null;
  return { headSha, baseSha, mode };
}

/**
 * @param {{ headSha: string, baseSha: string, mode?: string|null }} args
 * @returns {string}
 */
function formatReviewMeta({ headSha, baseSha, mode }) {
  if (!headSha || !baseSha) {
    throw new Error("formatReviewMeta requires headSha and baseSha");
  }
  if (mode == null || mode === "") {
    return `<!-- ai-review-meta head_sha=${headSha} base_sha=${baseSha} -->`;
  }
  return `<!-- ai-review-meta head_sha=${headSha} base_sha=${baseSha} mode=${mode} -->`;
}

/**
 * Resolve the git range for this review run from an already-parsed prior meta.
 *
 * - full → `baseSha` is the PR merge-base; `headSha` is current HEAD
 * - delta → `baseSha` is the prior published head; `headSha` is current HEAD
 *
 * @param {{
 *   priorMeta: { headSha: string, baseSha: string, mode: string|null } | null,
 *   headSha: string,
 *   mergeBaseSha: string,
 *   forceFull?: boolean,
 *   priorHeadIsAncestor?: boolean,
 * }} args
 * @returns {{ mode: 'full'|'delta', baseSha: string, headSha: string, reason: string }}
 */
function resolveReviewRange({
  priorMeta,
  headSha,
  mergeBaseSha,
  forceFull = false,
  priorHeadIsAncestor,
}) {
  const full = (reason) => ({
    mode: "full",
    baseSha: mergeBaseSha,
    headSha,
    reason,
  });

  if (forceFull) return full("force-full-review");
  if (!priorMeta || !priorMeta.headSha || !priorMeta.baseSha) {
    return full("missing-or-unparseable-meta");
  }
  if (!priorMeta.mode || priorMeta.mode === "inconclusive") {
    return full("prior-inconclusive");
  }
  if (priorMeta.mode !== "full" && priorMeta.mode !== "delta") {
    return full("missing-or-unparseable-meta");
  }
  // Spec §6.2: strict inequality on merge-base SHA.
  if (mergeBaseSha !== priorMeta.baseSha) {
    return full("base-sha-changed");
  }
  if (priorHeadIsAncestor !== true) {
    return full("prior-head-not-ancestor");
  }
  return {
    mode: "delta",
    baseSha: priorMeta.headSha,
    headSha,
    reason: "prior-meta-ancestor",
  };
}

/**
 * Pick the chronologically latest PR review body that carries `<!-- ai-review -->`.
 * @param {Array<{ body?: string, submitted_at?: string, submittedAt?: string, id?: number }>|null|undefined} reviews
 * @returns {{ body: string, submitted_at?: string, id?: number } | null}
 */
function findLatestAiReview(reviews) {
  if (!Array.isArray(reviews) || reviews.length === 0) return null;
  const candidates = reviews.filter(
    (r) => r && typeof r.body === "string" && r.body.includes(AI_REVIEW_MARKER)
  );
  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const ta = Date.parse(a.submitted_at || a.submittedAt || "") || 0;
    const tb = Date.parse(b.submitted_at || b.submittedAt || "") || 0;
    if (ta !== tb) return tb - ta;
    return (Number(b.id) || 0) - (Number(a.id) || 0);
  });
  return candidates[0];
}

/**
 * Walk prior reviews and decide full vs delta (frozen §10).
 *
 * `priorHeadIsAncestor` must be supplied by the caller (git merge-base --is-ancestor);
 * this module stays I/O-free.
 *
 * @param {{
 *   reviews: Array<{ body?: string, submitted_at?: string, id?: number }>,
 *   headSha: string,
 *   mergeBaseSha: string,
 *   forceFull?: boolean,
 *   priorHeadIsAncestor?: boolean,
 * }} args
 * @returns {{
 *   mode: 'full'|'delta',
 *   deltaBaseSha: string|null,
 *   priorHeadSha: string|null,
 *   priorBody: string|null,
 *   reason: string,
 * }}
 */
function resolveDeltaBaseline({
  reviews,
  headSha,
  mergeBaseSha,
  forceFull = false,
  priorHeadIsAncestor,
}) {
  const prior = findLatestAiReview(reviews);
  if (!prior) {
    return {
      mode: "full",
      deltaBaseSha: null,
      priorHeadSha: null,
      priorBody: null,
      reason: forceFull ? "force-full-review" : "no-prior-review",
    };
  }

  const meta = parseReviewMeta(prior.body);
  // forceFull still carries priorBody / priorHeadSha so Prep can write
  // prior-review.md for finding carry-forward on a forced full run.
  if (forceFull) {
    return {
      mode: "full",
      deltaBaseSha: null,
      priorHeadSha: meta && meta.headSha ? meta.headSha : null,
      priorBody: prior.body,
      reason: "force-full-review",
    };
  }

  if (!meta || !meta.headSha) {
    return {
      mode: "full",
      deltaBaseSha: null,
      priorHeadSha: null,
      priorBody: prior.body,
      reason: "missing-or-unparseable-meta",
    };
  }

  const range = resolveReviewRange({
    priorMeta: meta,
    headSha,
    mergeBaseSha,
    forceFull: false,
    priorHeadIsAncestor,
  });

  if (range.mode === "delta") {
    return {
      mode: "delta",
      deltaBaseSha: meta.headSha,
      priorHeadSha: meta.headSha,
      priorBody: prior.body,
      reason: range.reason,
    };
  }

  return {
    mode: "full",
    deltaBaseSha: null,
    priorHeadSha: meta.headSha,
    priorBody: prior.body,
    reason: range.reason,
  };
}

/**
 * Git base for numstat / unified diff this run. Telemetry `base_sha` stays
 * the PR merge-base; this is the active review range start.
 *
 * @param {{ mode: string, mergeBaseSha: string, deltaBaseSha?: string|null }} args
 * @returns {string}
 */
function resolveActiveReviewBase({ mode, mergeBaseSha, deltaBaseSha }) {
  if (mode === "delta" && deltaBaseSha) return deltaBaseSha;
  return mergeBaseSha;
}

/**
 * Frozen `.ai-review/delta.json` shape (spec §10).
 *
 * @param {{
 *   mode: string,
 *   reason: string,
 *   deltaBaseSha: string|null,
 *   priorHeadSha: string|null,
 *   headSha: string,
 *   mergeBaseSha: string,
 *   priorBodyPath: string|null,
 * }} args
 */
function buildDeltaArtifact({
  mode,
  reason,
  deltaBaseSha,
  priorHeadSha,
  headSha,
  mergeBaseSha,
  priorBodyPath,
}) {
  return {
    schema: 1,
    mode,
    reason,
    delta_base_sha: deltaBaseSha,
    prior_head_sha: priorHeadSha,
    head_sha: headSha,
    merge_base_sha: mergeBaseSha,
    prior_body_path: priorBodyPath,
  };
}

module.exports = {
  AI_REVIEW_MARKER,
  parseReviewMeta,
  formatReviewMeta,
  resolveReviewRange,
  findLatestAiReview,
  resolveDeltaBaseline,
  resolveActiveReviewBase,
  buildDeltaArtifact,
};
