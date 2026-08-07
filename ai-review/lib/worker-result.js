"use strict";

// Dead-worker detection for the ai-review orchestrator.
//
// The sentinel is the contract's completion evidence; `files_examined` is its
// coverage evidence. A worker that returns findings without a sentinel, or
// that examined a fraction of its assignment, is a GAP Opus must account for —
// never "nothing found". That distinction is why silent angle death, which the
// matrix route would have caught via job status, is caught here instead.
//
// Scan workers must examine at least one file — examining nothing means no
// angle was actually reviewed, even if focus is empty or missing. Test and
// collect workers have different contracts and are exempt.
//
// Known residual (spec section 5): both signals are self-reported, and a
// scoped short-lived worker is more steerable by hostile diff content than the
// 138-turn monolith was. Cross-checking `files_examined` against the session
// transcript's actual tool_use records is the stronger version.
//
// Pure: no I/O, no process.env.

const { FLOOR_ANGLES } = require("./plan-schema.js");

const SEVERITIES = Object.freeze(["P0", "P1", "P2", "P3"]);

const fail = (reason) => ({ ok: false, reason });

/**
 * @param {unknown} raw parsed worker output
 * @param {object} task the assignment it answers
 * @returns {{ok: true, result: object} | {ok: false, reason: string}}
 */
function validateWorkerResult(raw, task) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("result is not an object");
  }
  if (raw.sentinel !== "complete") {
    return fail(`missing or invalid sentinel (got ${JSON.stringify(raw.sentinel)})`);
  }
  if (raw.task_id !== task.id) {
    return fail(`task_id '${raw.task_id}' does not match assignment '${task.id}'`);
  }
  if (!Array.isArray(raw.findings)) return fail("findings must be an array");
  if (!Array.isArray(raw.files_examined)) return fail("files_examined must be an array");

  // A scan worker that examined nothing is dead — it cannot have reviewed the diff.
  if (task.kind === "scan" && raw.files_examined.length === 0) {
    return fail("scan worker examined no files — no angle was actually reviewed");
  }

  const examined = new Set(raw.files_examined);
  const focus = Array.isArray(task.focus) ? task.focus : [];
  const unexamined = focus.filter((f) => !examined.has(f));
  if (unexamined.length > 0) {
    return fail(`coverage shortfall — assigned but not examined: ${unexamined.join(", ")}`);
  }

  // The round a task was dispatched in, when the caller supplied one. Opus
  // legitimately reuses a task id like "s1" across rounds (see pipeline.js's
  // dispatch), so `${task.id}#${i}` alone is NOT unique across a review: round
  // 1's s1#0 and round 2's s1#0 are different findings that both survive
  // dedupe (different files), and applyRefutations matches ids through a Set —
  // one refutation would silently delete both, dropping a real P0 out of
  // `counts`. Scoping the id by round is what makes a refutation address
  // exactly one finding.
  const round =
    task && task.round !== undefined && task.round !== null && String(task.round).length > 0
      ? task.round
      : null;

  const findings = [];
  for (const [i, f] of raw.findings.entries()) {
    if (!f || typeof f !== "object") return fail(`findings[${i}] is not an object`);
    if (!SEVERITIES.includes(f.severity)) {
      return fail(`findings[${i}].severity '${f.severity}' is not one of ${SEVERITIES.join(", ")}`);
    }
    for (const k of ["file", "defect_class", "claim", "evidence"]) {
      if (typeof f[k] !== "string" || f[k].length === 0) {
        return fail(`findings[${i}].${k} must be a non-empty string`);
      }
    }
    if (!Number.isFinite(Number(f.line))) return fail(`findings[${i}].line must be a number`);

    findings.push({
      ...f,
      line: Number(f.line),
      // Attribution: a miss must resolve to a shard+model+round triple, not
      // "the orchestrator". The id is what a judge refutation references.
      id: round === null ? `${task.id}#${i}` : `${task.id}#r${round}#${i}`,
      shard: task.id,
      model: task.model,
      round,
    });
  }

  return {
    ok: true,
    result: {
      task_id: raw.task_id,
      angles: Array.isArray(raw.angles) ? raw.angles : task.angles,
      files_examined: raw.files_examined,
      findings,
      evidence: Array.isArray(raw.evidence) ? raw.evidence : [],
    },
  };
}

/**
 * Floor angles left uncovered because their scan workers died.
 *
 * @param {object[]} planTasks
 * @param {object[]} completedResults results that passed validateWorkerResult
 * @returns {string[]} uncovered floor angles, in FLOOR_ANGLES order
 */
function coverageGaps(planTasks, completedResults) {
  const completed = new Set(
    (Array.isArray(completedResults) ? completedResults : []).map((r) => r && r.task_id)
  );
  const covered = new Set();
  for (const t of Array.isArray(planTasks) ? planTasks : []) {
    if (!t || t.kind !== "scan" || !completed.has(t.id)) continue;
    for (const a of Array.isArray(t.angles) ? t.angles : []) covered.add(a);
  }
  return FLOOR_ANGLES.filter((a) => !covered.has(a));
}

module.exports = { validateWorkerResult, coverageGaps, SEVERITIES };
