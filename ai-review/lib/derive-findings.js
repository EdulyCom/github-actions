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

  // Ids are namespaced by role, always. The schema's `id` is a bare string with
  // no format guidance, so two reviewer sessions running the same prompt will
  // plausibly both emit "F1" — and `aggregate.js` rejects a cross-role duplicate,
  // correctly, since its score join is keyed by id. Without the prefix that turns
  // two perfectly good non-overlapping reviews into a whole-PR failure. Safe
  // because §6.6 dedupe keys on file+line+reason, never on id, so genuine
  // duplicate findings still merge across roles.
  // Unconditional, not "skip if it already looks prefixed" — that conditional
  // was tried first and is not injective: a model that applies its own
  // namespacing convention inconsistently within one response can emit both
  // "F1" and "reviewer-1/F1", and a startsWith check maps both to the same
  // string. That is the exact collision this function exists to prevent,
  // reached from inside a single role instead of across two. Unconditional
  // prefixing cannot collide by construction, at the cost of an ugly
  // "role/role/id" when a model already prefixed correctly — never wrong,
  // and nothing downstream parses the id's structure.
  const namespaced = (raw) => `${role}/${raw}`;

  // The `auto-` stem keeps the generated fallback out of the space a model id
  // can land in — narrows the collision window, but "auto-" is only a
  // convention, not reserved: a model that happens to emit the literal string
  // "auto-0002" would still collide with whatever finding's OWN generated
  // fallback that is. RESERVED is what makes the invariant hold by
  // construction: a raw id matching the generated shape is never trusted as a
  // model value — it is always replaced by THIS finding's own generatedId(i).
  // generatedId is injective over the array index, so two different findings
  // can never be forced to the same reserved-pattern id, however a model
  // spells its own.
  const GENERATED_ID_RE = /^auto-\d{4}$/;
  const generatedId = (i) => `auto-${String(i + 1).padStart(4, "0")}`;

  const findings = review.findings.map((f, i) => ({
    id: namespaced(
      typeof f.id === "string" && f.id !== "" && !GENERATED_ID_RE.test(f.id)
        ? f.id
        : generatedId(i),
    ),
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
      // No fallback to `review.files_reviewed`. That would hand aggregate.js a
      // model claim to compare against another copy of the same claim, which is
      // exactly what the JSDoc above says this field exists to avoid — and it
      // breaks aggregation's partition check, which requires assigned_files to
      // be a subset of changed_files while files_reviewed is explicitly allowed
      // to range outside the diff (a reviewer reading a neighbour for context).
      // An empty assignment fails closed with a diagnosable reason instead.
      assigned_files: Array.isArray(o.assignedFiles) ? o.assignedFiles : [],
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
