"use strict";

// Validation for the Opus-authored task plan.
//
// The floor is angles A-G. Angle H is satisfied by a separate call BEFORE the
// planner reads the diff (rubric.md:55-60 requires intent framing first, and
// re-deriving it afterwards does not count), so H never appears in a plan —
// tracking it here would invite Opus to re-run it post-diff.
//
// Only `kind: "scan"` tasks count toward coverage: collection gathers facts,
// scanning covers angles. A plan that "covers" Angle C with a Haiku file
// inventory is not a review.
//
// Pure: no I/O, no process.env.

const FLOOR_ANGLES = Object.freeze(["A", "B", "C", "D", "E", "F", "G"]);
const ALL_ANGLES = Object.freeze([...FLOOR_ANGLES, "H"]);
const KINDS = Object.freeze(["collect", "scan", "verify", "test"]);
const MODELS = Object.freeze(["haiku", "sonnet"]);

/**
 * @param {unknown} plan
 * @param {{maxTasks: number}} options
 * @returns {{ok: true} | {ok: false, violations: string[]}}
 */
function validatePlan(plan, options) {
  const violations = [];
  const maxTasks = Number(options && options.maxTasks) || 12;

  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { ok: false, violations: ["plan is not an object"] };
  }

  // Collection plans have no angles to cover; only test plans face the floor.
  const requireFloor = !(options && options.requireFloor === false);

  const tasks = plan.tasks;
  if (!Array.isArray(tasks)) {
    return { ok: false, violations: ["plan.tasks must be a non-empty array"] };
  }
  // A collection round may legitimately have nothing to collect for a small
  // diff — only a round that must cover the floor requires at least one task.
  if (requireFloor && tasks.length === 0) {
    return { ok: false, violations: ["plan.tasks must be a non-empty array"] };
  }
  if (tasks.length > maxTasks) {
    violations.push(`plan has ${tasks.length} tasks, exceeding the per-round cap of ${maxTasks}`);
  }

  const seenIds = new Set();
  const coveredByScan = new Set();

  for (const [i, t] of tasks.entries()) {
    const where = `tasks[${i}]`;

    if (!t || typeof t !== "object") {
      violations.push(`${where} is not an object`);
      continue;
    }
    if (typeof t.id !== "string" || t.id.length === 0) {
      violations.push(`${where}.id must be a non-empty string`);
    } else if (seenIds.has(t.id)) {
      violations.push(`${where}.id '${t.id}' is a duplicate`);
    } else {
      seenIds.add(t.id);
    }

    if (!KINDS.includes(t.kind)) {
      violations.push(`${where}.kind '${t.kind}' is not one of ${KINDS.join(", ")}`);
    }
    if (!MODELS.includes(t.model)) {
      violations.push(
        t.model === "opus"
          ? `${where}.model is 'opus' — Opus plans and judges but never executes tasks`
          : `${where}.model '${t.model}' is not one of ${MODELS.join(", ")}`
      );
    }
    if (typeof t.question !== "string" || t.question.length === 0) {
      violations.push(`${where}.question must be a non-empty string`);
    }
    if (typeof t.rationale !== "string" || t.rationale.length === 0) {
      violations.push(`${where}.rationale must be a non-empty string (why this model)`);
    }
    if (!Array.isArray(t.angles)) {
      violations.push(`${where}.angles must be an array`);
      continue;
    }
    for (const a of t.angles) {
      if (!ALL_ANGLES.includes(a)) violations.push(`${where}.angles contains unknown angle '${a}'`);
    }
    if (t.kind === "scan") {
      if (t.angles.length === 0) violations.push(`${where} is a scan task with no angles`);
      for (const a of t.angles) coveredByScan.add(a);
    }
  }

  if (requireFloor) {
    const missing = FLOOR_ANGLES.filter((a) => !coveredByScan.has(a));
    if (missing.length > 0) {
      violations.push(
        `scan tasks do not cover the mandatory floor — missing angle(s): ${missing.join(", ")}`
      );
    }
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

module.exports = { validatePlan, FLOOR_ANGLES, ALL_ANGLES, KINDS, MODELS };
