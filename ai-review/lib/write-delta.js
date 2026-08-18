"use strict";

// I/O wrapper: list prior bot reviews → resolve full|delta → write
// `.ai-review/delta.json` and optional `.ai-review/prior-review.md`.
// Pure resolution lives in delta.js; this script only talks to git/fs.
//
// Env:
//   HEAD_SHA, BASE_SHA (PR merge-base), FORCE_FULL_REVIEW ("true"|"false")
//   AUTHOR_LOGIN (optional filter), REVIEWS_JSON_PATH (default .ai-review/reviews.json)
//
// Prints shell-friendly KEY=value lines for the prep step (mode, review-base-sha, …).

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  findLatestAiReview,
  parseReviewMeta,
  resolveDeltaBaseline,
  resolveActiveReviewBase,
  buildDeltaArtifact,
} = require("./delta.js");

const DIR = ".ai-review";
const PRIOR_REL = ".ai-review/prior-review.md";

/**
 * @param {string} priorSha
 * @param {string} headSha
 * @param {{ execFileSync?: typeof execFileSync }} [io]
 */
function priorHeadIsAncestorOf(priorSha, headSha, io) {
  const exec = (io && io.execFileSync) || execFileSync;
  try {
    exec("git", ["merge-base", "--is-ancestor", priorSha, headSha], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {unknown} raw
 * @param {string} authorLogin
 */
function filterBotReviews(raw, authorLogin) {
  const list = Array.isArray(raw) ? raw : [];
  if (!authorLogin) return list;
  return list.filter((r) => r && r.user && r.user.login === authorLogin);
}

/**
 * @param {{
 *   reviews?: unknown,
 *   headSha: string,
 *   mergeBaseSha: string,
 *   forceFull?: boolean,
 *   authorLogin?: string,
 *   dir?: string,
 *   io?: {
 *     writeFile?: typeof fs.writeFileSync,
 *     mkdir?: typeof fs.mkdirSync,
 *     execFileSync?: typeof execFileSync,
 *     log?: (s: string) => void,
 *   },
 * }} args
 */
function writeDeltaArtifacts({
  reviews,
  headSha,
  mergeBaseSha,
  forceFull = false,
  authorLogin = "",
  dir = DIR,
  io,
}) {
  const writeFile = (io && io.writeFile) || fs.writeFileSync;
  const mkdir = (io && io.mkdir) || ((p) => fs.mkdirSync(p, { recursive: true }));
  const log = (io && io.log) || ((s) => process.stderr.write(s));

  const filtered = filterBotReviews(reviews, authorLogin);
  const prior = findLatestAiReview(filtered);
  let ancestor = false;
  if (prior) {
    const meta = parseReviewMeta(prior.body);
    if (meta && meta.headSha) {
      ancestor = priorHeadIsAncestorOf(meta.headSha, headSha, io);
    }
  }

  const baseline = resolveDeltaBaseline({
    reviews: filtered,
    headSha,
    mergeBaseSha,
    forceFull,
    priorHeadIsAncestor: ancestor,
  });

  mkdir(dir);

  let priorBodyPath = null;
  if (baseline.priorBody) {
    const absPrior = path.join(dir, "prior-review.md");
    writeFile(absPrior, baseline.priorBody);
    priorBodyPath = PRIOR_REL;
  }

  const artifact = buildDeltaArtifact({
    mode: baseline.mode,
    reason: baseline.reason,
    deltaBaseSha: baseline.deltaBaseSha,
    priorHeadSha: baseline.priorHeadSha,
    headSha,
    mergeBaseSha,
    priorBodyPath,
  });
  writeFile(path.join(dir, "delta.json"), `${JSON.stringify(artifact, null, 2)}\n`);

  const reviewBase = resolveActiveReviewBase({
    mode: baseline.mode,
    mergeBaseSha,
    deltaBaseSha: baseline.deltaBaseSha,
  });

  log(
    `delta: mode=${baseline.mode} reason=${baseline.reason} ` +
      `review_base=${reviewBase.slice(0, 12)}…` +
      (baseline.priorBody ? " prior-review.md=yes" : " prior-review.md=no") +
      "\n",
  );

  return {
    baseline,
    artifact,
    reviewBaseSha: reviewBase,
  };
}

function main() {
  const reviewsPath =
    process.env.REVIEWS_JSON_PATH || path.join(DIR, "reviews.json");
  let reviews = [];
  try {
    reviews = JSON.parse(fs.readFileSync(reviewsPath, "utf8"));
  } catch {
    reviews = [];
  }

  const headSha = process.env.HEAD_SHA || "";
  const mergeBaseSha = process.env.BASE_SHA || "";
  if (!headSha || !mergeBaseSha) {
    throw new Error("write-delta.js requires HEAD_SHA and BASE_SHA");
  }

  const { baseline, reviewBaseSha } = writeDeltaArtifacts({
    reviews,
    headSha,
    mergeBaseSha,
    forceFull: process.env.FORCE_FULL_REVIEW === "true",
    authorLogin: process.env.AUTHOR_LOGIN || "",
  });

  // Shell-readable lines for the prep step (not GITHUB_OUTPUT — caller copies).
  process.stdout.write(`mode=${baseline.mode}\n`);
  process.stdout.write(`reason=${baseline.reason}\n`);
  process.stdout.write(`review-base-sha=${reviewBaseSha}\n`);
  process.stdout.write(
    `delta-base-sha=${baseline.deltaBaseSha || ""}\n`,
  );
  process.stdout.write(
    `prior-head-sha=${baseline.priorHeadSha || ""}\n`,
  );
}

module.exports = {
  priorHeadIsAncestorOf,
  filterBotReviews,
  writeDeltaArtifacts,
  main,
};

if (require.main === module) main();
