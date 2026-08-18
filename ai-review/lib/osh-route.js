"use strict";

// OSH topology for the review stage (collapse vs fan-out).
//
// Roster `k` is sized from full-file bytes at HEAD so coverage packing stays
// honest. That over-triggers Opus fan-out on small diffs that only *touch*
// large files (e.g. CSS tokenization in a 130 KiB stylesheet). Fan-out's
// value is parallel coverage of a large *change*, not re-reading a big file
// for a few dozen churn lines.
//
// Rule: collapse (single Sonnet) when K≤1 OR churn ≤ COLLAPSE_CHURN_MAX.
// Fan-out only when K>1 AND churn is above that ceiling. Must-read-all of
// the active range is unchanged either way.

/** Max added+deleted lines that still prefer Sonnet collapse over Opus fan-out. */
const COLLAPSE_CHURN_MAX = 1500;

/**
 * @param {{
 *   k?: number|string|null,
 *   churn?: number|string|null,
 *   collapseChurnMax?: number|string|null,
 * }} args
 * @returns {{
 *   oshMode: 'collapse'|'fanout',
 *   reason: string,
 *   k: number,
 *   churn: number,
 *   collapseChurnMax: number,
 *   runContextStage: boolean,
 * }}
 *
 * `runContextStage` is true only for fan-out: prep already wrote deterministic
 * context.md, and collapse reviews are small enough that Haiku is pure
 * wall-clock (delta or small-churn full).
 */
function resolveOshRoute({ k, churn, collapseChurnMax } = {}) {
  const kNum = Number(k);
  const kSafe = Number.isFinite(kNum) && kNum > 0 ? Math.floor(kNum) : 0;
  const churnNum = Number(churn);
  const churnSafe = Number.isFinite(churnNum) && churnNum > 0 ? Math.floor(churnNum) : 0;
  const maxNum = Number(collapseChurnMax);
  const maxSafe =
    Number.isFinite(maxNum) && maxNum > 0 ? Math.floor(maxNum) : COLLAPSE_CHURN_MAX;

  if (kSafe <= 1) {
    return {
      oshMode: "collapse",
      reason: "k-le-1",
      k: kSafe,
      churn: churnSafe,
      collapseChurnMax: maxSafe,
      runContextStage: false,
    };
  }
  if (churnSafe <= maxSafe) {
    return {
      oshMode: "collapse",
      reason: "churn-le-ceiling",
      k: kSafe,
      churn: churnSafe,
      collapseChurnMax: maxSafe,
      runContextStage: false,
    };
  }
  return {
    oshMode: "fanout",
    reason: "k-gt-1-and-churn-over",
    k: kSafe,
    churn: churnSafe,
    collapseChurnMax: maxSafe,
    runContextStage: true,
  };
}

module.exports = {
  COLLAPSE_CHURN_MAX,
  resolveOshRoute,
};
