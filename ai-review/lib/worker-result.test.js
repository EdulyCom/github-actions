"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateWorkerResult, coverageGaps } = require("./worker-result.js");

const task = (over) => ({
  id: "t1", kind: "scan", angles: ["A"], model: "sonnet",
  focus: ["a.js"], question: "q", rationale: "r", ...over,
});

const raw = (over) => ({
  task_id: "t1", angles: ["A"], files_examined: ["a.js"],
  findings: [], evidence: [], sentinel: "complete", ...over,
});

const finding = (over) => ({
  severity: "P1", file: "a.js", line: 1,
  defect_class: "d", claim: "c", evidence: "e", ...over,
});

test("accepts a well-formed complete result", () => {
  const res = validateWorkerResult(raw(), task());
  assert.equal(res.ok, true, res.reason);
});

test("rejects a missing sentinel — a result without it is a dead worker", () => {
  const r = raw();
  delete r.sentinel;
  const res = validateWorkerResult(r, task());
  assert.equal(res.ok, false);
  assert.match(res.reason, /sentinel/);
});

test("rejects a sentinel with the wrong value", () => {
  assert.equal(validateWorkerResult(raw({ sentinel: "done" }), task()).ok, false);
});

test("rejects a task_id that does not match the assignment", () => {
  const res = validateWorkerResult(raw({ task_id: "other" }), task());
  assert.equal(res.ok, false);
  assert.match(res.reason, /task_id/);
});

test("rejects a coverage shortfall — assigned focus not examined", () => {
  const res = validateWorkerResult(
    raw({ files_examined: ["b.js"] }),
    task({ focus: ["a.js", "b.js"] })
  );
  assert.equal(res.ok, false);
  assert.match(res.reason, /a\.js/);
});

test("accepts examining MORE than the focus — scope is attention, not a ceiling", () => {
  const res = validateWorkerResult(
    raw({ files_examined: ["a.js", "helper.js"] }),
    task({ focus: ["a.js"] })
  );
  assert.equal(res.ok, true, res.reason);
});

test("rejects a finding with an unknown severity", () => {
  const res = validateWorkerResult(raw({ findings: [finding({ severity: "P9" })] }), task());
  assert.equal(res.ok, false);
  assert.match(res.reason, /P9/);
});

test("rejects a finding missing evidence", () => {
  const f = finding();
  delete f.evidence;
  assert.equal(validateWorkerResult(raw({ findings: [f] }), task()).ok, false);
});

test("rejects null and non-object results without throwing", () => {
  assert.equal(validateWorkerResult(null, task()).ok, false);
  assert.equal(validateWorkerResult("{}", task()).ok, false);
});

test("stamps findings with id, shard, and model for attribution", () => {
  const res = validateWorkerResult(raw({ findings: [finding()] }), task());
  assert.equal(res.result.findings[0].shard, "t1");
  assert.equal(res.result.findings[0].model, "sonnet");
  assert.ok(res.result.findings[0].id, "every finding needs a stable id for refutation");
});

test("the same task id in two rounds yields DIFFERENT finding ids", () => {
  const r1 = validateWorkerResult(raw({ findings: [finding()] }), task({ round: 1 }));
  const r2 = validateWorkerResult(raw({ findings: [finding({ file: "b.js" })] }), task({ round: 2 }));
  assert.notEqual(
    r1.result.findings[0].id,
    r2.result.findings[0].id,
    "colliding ids mean one judge refutation silently deletes both findings"
  );
  assert.equal(r1.result.findings[0].id, "t1#r1#0");
  assert.equal(r2.result.findings[0].id, "t1#r2#0");
});

test("a finding carries the round it was found in, for attribution", () => {
  const res = validateWorkerResult(raw({ findings: [finding()] }), task({ round: 2 }));
  assert.equal(res.result.findings[0].round, 2);
});

test("a non-numeric round (the collection dispatch) still scopes the id", () => {
  const res = validateWorkerResult(raw({ findings: [finding()] }), task({ round: "collect" }));
  assert.equal(res.result.findings[0].id, "t1#rcollect#0");
  assert.equal(res.result.findings[0].round, "collect");
});

test("a task with no round falls back to the unscoped id", () => {
  const res = validateWorkerResult(raw({ findings: [finding()] }), task());
  assert.equal(res.result.findings[0].id, "t1#0");
  assert.equal(res.result.findings[0].round, null);
});

test("a scan worker that examined nothing is dead, even with an empty focus", () => {
  const res = validateWorkerResult(
    raw({ files_examined: [] }),
    task({ kind: "scan", focus: [] })
  );
  assert.equal(res.ok, false, "no files read means no angle was actually reviewed");
  assert.match(res.reason, /examined/i);
});

test("a scan worker with an empty focus is fine once it examined something", () => {
  const res = validateWorkerResult(
    raw({ files_examined: ["a.js"] }),
    task({ kind: "scan", focus: [] })
  );
  assert.equal(res.ok, true, res.reason);
});

test("a test worker may legitimately examine no files", () => {
  const res = validateWorkerResult(
    raw({ task_id: "x1", files_examined: [] }),
    task({ id: "x1", kind: "test", focus: [] })
  );
  assert.equal(res.ok, true, res.reason);
});

test("coverageGaps reports every floor angle when the only scan worker died", () => {
  const tasks = [task({ id: "t1", angles: ["A", "B", "C", "D", "E", "F", "G"] })];
  assert.deepEqual(coverageGaps(tasks, []), ["A", "B", "C", "D", "E", "F", "G"]);
});

test("coverageGaps is empty when every floor angle has a complete scan worker", () => {
  const tasks = [task({ id: "t1", angles: ["A", "B", "C", "D", "E", "F", "G"] })];
  assert.deepEqual(coverageGaps(tasks, [{ task_id: "t1" }]), []);
});

test("coverageGaps ignores collect tasks when computing the floor", () => {
  const tasks = [
    task({ id: "c1", kind: "collect", angles: [] }),
    task({ id: "s1", angles: ["A", "B", "C", "D", "E", "F", "G"] }),
  ];
  assert.deepEqual(coverageGaps(tasks, [{ task_id: "s1" }]), []);
});
