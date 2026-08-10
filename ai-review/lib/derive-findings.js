"use strict";

// Split one schema-validated blob into the two artifacts lib/aggregate.js reads.
//
// Why this exists instead of asking the model to write the files itself:
//
//   1. Enforcement. `--json-schema` constrains the model's structured output at
//      the point of generation. A prose instruction to "also write these two
//      files" has nothing behind it — measured on run 31360398002, where the
//      instruction never even reached the step that could write, and on the
//      spec's own PR-C plan, which would have deleted the schema and left the
//      files validated only after the fact, where malformed means FAILURE
//      rather than correction.
//   2. Blast radius. Emitting the files from the model requires granting `Write`
//      to a session that ingests the PR diff, PR body and linked-issue bodies,
//      while a later step `require()`s JS from `github.action_path` in-process
//      with a write-scoped App token. Deriving them here removes the write
//      primitive entirely rather than trying to fence it — and fencing it is
//      not straightforward: Claude Code accepts a `Write(path)` permission rule
//      and never consults it (only `Edit(path)` and `Read(path)` are checked),
//      so the obvious scoping would look right in review and enforce nothing.
//
// The `findings` and `files_reviewed` schema fields are OPTIONAL on purpose. A
// model that omits them yields null here and a `missing:` line from the shadow
// step — observable, and never a failure, since nothing gates on this yet.
//
// Pure: no I/O, no process.env. The caller reads structured_output and writes
// whatever this returns.

const SEVERITIES = ["P0", "P1", "P2", "P3"];

/**
 * @param {object} review  parsed `structured_output` from the review stage
 * @param {object} opts
 * @param {string} opts.role           role name to stamp on both artifacts
 * @param {string[]} [opts.assignedFiles]  authoritative list from manifest.json;
 *   deliberately NOT taken from the model, so the coverage assertion in
 *   aggregate.js compares a model claim against a deterministic fact rather
 *   than against another copy of the same claim.
 * @param {string} [opts.model]
 * @returns {{findings: object, scores: object}|null}
 */
function deriveArtifacts(review, opts) {
  const o = opts || {};
  const role = o.role || "review-serial";

  if (review === null || typeof review !== "object" || Array.isArray(review)) {
    return null;
  }
  if (!Array.isArray(review.findings)) return null;
  if (!Array.isArray(review.files_reviewed)) return null;

  const findings = review.findings.map((f, i) => ({
    id: typeof f.id === "string" && f.id !== "" ? f.id : `${role}/${String(i + 1).padStart(4, "0")}`,
    file: f.file ?? null,
    line: typeof f.line === "number" ? f.line : null,
    severity: f.severity,
    summary: f.summary ?? "",
    failure_scenario: f.failure_scenario ?? "",
    reason: f.reason ?? "unspecified",
    evidence: f.evidence ?? "",
  }));

  // One score per finding, in the same order. The join in aggregate.js asserts
  // set equality both ways, so deriving both sides from one array means a score
  // gap is unreachable by construction rather than by the model's diligence.
  const scores = review.findings.map((f, i) => ({
    id: findings[i].id,
    confidence: typeof f.confidence === "number" ? f.confidence : null,
    severity_confirmed: SEVERITIES.includes(f.severity_confirmed)
      ? f.severity_confirmed
      : f.severity,
  }));

  return {
    findings: {
      schema: 1,
      role,
      complete: true,
      model_used: o.model || null,
      assigned_files: Array.isArray(o.assignedFiles)
        ? o.assignedFiles
        : review.files_reviewed,
      files_reviewed: review.files_reviewed,
      intent: review.intent ?? null,
      checklist: Array.isArray(review.checklist) ? review.checklist : [],
      findings,
    },
    scores: {
      schema: 1,
      role: "scorer",
      complete: true,
      scores,
    },
  };
}

module.exports = { deriveArtifacts };
