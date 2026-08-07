"use strict";

// Validation for the DETERMINISTIC prep step's output.
//
// Every other fail-closed check in this system validates what a MODEL
// returned. This one validates what the prep step supplied, and it is the
// only thing standing between a silent prep failure and a confident PASS:
//
// `action.yml`'s "Build diff and context pack" step is `continue-on-error:
// true`, and orchestrator/index.js swallows both missing files into `{}` and
// `""`. So if `git merge-base` fails, the step goes red, the job continues,
// and the pipeline runs on an EMPTY diff — while the workers still hold
// Read/Grep/Glob on a live checkout. They read real files, report plausible
// `files_examined`, and find nothing to report against a diff that isn't
// there; coverageGaps comes back empty because the workers did complete; the
// judge sees no findings; and the gate approves with confidence 100. A
// review that never happened would be indistinguishable from a clean one.
//
// Pure: no I/O, no process.env.

/**
 * @param {unknown} pack parsed .ai-review/context-pack.json
 * @param {unknown} diff contents of .ai-review/diff.patch
 * @returns {string|null} the specific defect, or null when prep is usable
 */
function unusablePrep(pack, diff) {
  if (typeof diff !== "string" || diff.trim().length === 0) {
    return "the diff is empty";
  }
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
    return "the context pack is missing or is not an object";
  }
  for (const key of ["head_sha", "base_sha"]) {
    if (typeof pack[key] !== "string" || pack[key].trim().length === 0) {
      return `the context pack has no ${key}`;
    }
  }
  if (!Array.isArray(pack.changed_files) || pack.changed_files.length === 0) {
    return "the context pack lists no changed files";
  }
  return null;
}

module.exports = { unusablePrep };
