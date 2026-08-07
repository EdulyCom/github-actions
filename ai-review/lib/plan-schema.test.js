"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePlan, FLOOR_ANGLES } = require("./plan-schema.js");

const scan = (over) => ({
  id: "t1", kind: "scan", angles: [...FLOOR_ANGLES],
  model: "sonnet", focus: ["a.js"], question: "q", rationale: "r", ...over,
});

const plan = (over) => ({ round: 1, tasks: [scan()], rationale: "r", ...over });

test("accepts a single task covering A-G — the sized-down plan for a typo PR", () => {
  const res = validatePlan(plan(), { maxTasks: 12 });
  assert.equal(res.ok, true, JSON.stringify(res.violations));
});

test("rejects a plan missing a floor angle, and names the angle", () => {
  const res = validatePlan(plan({ tasks: [scan({ angles: ["A", "B"] })] }), { maxTasks: 12 });
  assert.equal(res.ok, false);
  assert.ok(
    res.violations.some((v) => v.includes("C") && v.includes("G")),
    `violations should name the uncovered angles, got: ${JSON.stringify(res.violations)}`
  );
});

test("rejects model: opus — Opus never delegates to itself", () => {
  const res = validatePlan(plan({ tasks: [scan({ model: "opus" })] }), { maxTasks: 12 });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.includes("opus")));
});

test("rejects more tasks than the per-round cap", () => {
  const tasks = Array.from({ length: 13 }, (_, i) => scan({ id: `t${i}` }));
  const res = validatePlan(plan({ tasks }), { maxTasks: 12 });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.includes("12")));
});

test("rejects duplicate task ids", () => {
  const res = validatePlan(plan({ tasks: [scan({ id: "dup" }), scan({ id: "dup" })] }), { maxTasks: 12 });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.includes("dup")));
});

test("collect tasks do not count toward angle coverage", () => {
  const res = validatePlan(
    plan({ tasks: [{ id: "c1", kind: "collect", angles: [], model: "haiku", focus: [], question: "q", rationale: "r" },
                   scan({ id: "s1", angles: ["A"] })] }),
    { maxTasks: 12 }
  );
  assert.equal(res.ok, false, "a collect task must not satisfy the scan floor");
});

const testTask = (over) => ({
  id: "x1", kind: "test", angles: [], model: "sonnet",
  focus: [], question: "q", rationale: "r", ...over,
});

test("accepts a plan with exactly one kind:\"test\" task", () => {
  const res = validatePlan(plan({ tasks: [scan(), testTask()] }), { maxTasks: 12 });
  assert.equal(res.ok, true, JSON.stringify(res.violations));
});

test("rejects more than one kind:\"test\" task, naming the offenders", () => {
  const res = validatePlan(
    plan({ tasks: [scan(), testTask({ id: "x1" }), testTask({ id: "x2" })] }),
    { maxTasks: 12 }
  );
  assert.equal(res.ok, false, "only one worker may hold the exec allowlist");
  assert.ok(
    res.violations.some((v) => v.includes("x1") && v.includes("x2")),
    `the violation must name the offending ids, got: ${JSON.stringify(res.violations)}`
  );
});

test("rejects an angle outside A-H", () => {
  const res = validatePlan(plan({ tasks: [scan({ angles: [...FLOOR_ANGLES, "Z"] })] }), { maxTasks: 12 });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.includes("Z")));
});

test("rejects an empty task list", () => {
  const res = validatePlan(plan({ tasks: [] }), { maxTasks: 12 });
  assert.equal(res.ok, false);
});

test("rejects a non-object plan without throwing", () => {
  assert.equal(validatePlan(null, { maxTasks: 12 }).ok, false);
  assert.equal(validatePlan("nope", { maxTasks: 12 }).ok, false);
});

test("accepts angles spread across several scan tasks", () => {
  const res = validatePlan(
    plan({ tasks: [
      scan({ id: "s1", angles: ["A", "B", "C"], model: "sonnet" }),
      scan({ id: "s2", angles: ["D", "E", "F", "G"], model: "haiku" }),
    ] }),
    { maxTasks: 12 }
  );
  assert.equal(res.ok, true, JSON.stringify(res.violations));
});

test("requireFloor: false skips the floor check for collection rounds", () => {
  const collect = { round: 1, rationale: "r", tasks: [
    { id: "c1", kind: "collect", angles: [], model: "haiku", focus: [], question: "q", rationale: "r" },
  ] };
  assert.equal(validatePlan(collect, { maxTasks: 12, requireFloor: false }).ok, true);
  assert.equal(validatePlan(collect, { maxTasks: 12 }).ok, false, "the floor still applies by default");
});

test("rejects a task id that could escape a filesystem path", () => {
  const res = validatePlan(plan({ tasks: [scan({ id: "../../../etc/passwd" })] }), { maxTasks: 12 });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.includes("id")),
    "the planner reads an attacker-controlled diff; ids reach log filenames");
});

test("rejects a task id with a path separator or a space", () => {
  for (const bad of ["a/b", "a\\b", "a b", "a.b"]) {
    const res = validatePlan(plan({ tasks: [scan({ id: bad })] }), { maxTasks: 12 });
    assert.equal(res.ok, false, `id '${bad}' should be rejected`);
  }
});

test("accepts ordinary task ids", () => {
  for (const good of ["t1", "scan-A", "collect_1", "S1"]) {
    const res = validatePlan(plan({ tasks: [scan({ id: good })] }), { maxTasks: 12 });
    assert.equal(res.ok, true, `id '${good}' should be accepted: ${JSON.stringify(res.violations)}`);
  }
});
