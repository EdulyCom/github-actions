"use strict";

// The rubric's Angle H skip condition, expressed as code.
//
// rubric.md:44-46 exempts docs/chore/style diffs from intent alignment. This
// is the ONLY floor relaxation in the design — angles A-G have no rubric-
// sanctioned exemption, so a small diff is sized down with task count, not by
// dropping angles.
//
// Deliberately conservative: anything not provably inert is NOT exempt.
// Getting this wrong in the exempt direction skips a mandatory angle.
//
// Pure: no I/O, no process.env.

const EXEMPT_PATTERNS = [
  /\.md$/i,
  /\.mdx$/i,
  /\.txt$/i,
  /^docs\//i,
  /^\.github\/ISSUE_TEMPLATE\//i,
  /(^|\/)(LICENSE|NOTICE|CODEOWNERS|CHANGELOG)(\.\w+)?$/i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock)$/i,
];

/**
 * @param {unknown} changedFiles
 * @returns {boolean} true only when EVERY changed file is provably inert
 */
function isIntentExempt(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return false;
  return changedFiles.every(
    (f) => typeof f === "string" && EXEMPT_PATTERNS.some((re) => re.test(f))
  );
}

module.exports = { isIntentExempt, EXEMPT_PATTERNS };
