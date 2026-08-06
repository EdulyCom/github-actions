"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { dedupe, applyRefutations, countBySeverity } = require("./merge.js");

const f = (over) => ({
  id: "x", severity: "P2", file: "a.js", line: 10,
  defect_class: "null-deref", claim: "c", evidence: "e",
  shard: "s", model: "sonnet", round: 1, ...over,
});

test("dedupe merges same file+class within the line window, keeping the worse severity", () => {
  const { findings } = dedupe([
    f({ id: "1", severity: "P2", line: 10 }),
    f({ id: "2", severity: "P0", line: 12 }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "P0", "worst severity wins the merge");
});

test("dedupe records what it absorbed — nothing is silently dropped", () => {
  const { absorbed } = dedupe([
    f({ id: "1", line: 10 }),
    f({ id: "2", line: 11 }),
  ]);
  assert.deepEqual(absorbed, [{ kept: "1", absorbed: "2" }]);
});

test("dedupe keeps different defect classes at the same line separate", () => {
  const { findings } = dedupe([
    f({ id: "1", defect_class: "null-deref" }),
    f({ id: "2", defect_class: "off-by-one" }),
  ]);
  assert.equal(findings.length, 2);
});

test("dedupe never merges across files", () => {
  const { findings } = dedupe([
    f({ id: "1", file: "a.js" }),
    f({ id: "2", file: "b.js" }),
  ]);
  assert.equal(findings.length, 2);
});

test("dedupe keeps findings beyond the line window separate", () => {
  const { findings } = dedupe([
    f({ id: "1", line: 10 }),
    f({ id: "2", line: 100 }),
  ]);
  assert.equal(findings.length, 2);
});

test("dedupe is order-independent on which severity survives", () => {
  const a = dedupe([f({ id: "1", severity: "P0" }), f({ id: "2", severity: "P3" })]);
  const b = dedupe([f({ id: "1", severity: "P3" }), f({ id: "2", severity: "P0" })]);
  assert.equal(a.findings[0].severity, "P0");
  assert.equal(b.findings[0].severity, "P0");
});

test("countBySeverity counts each band", () => {
  const counts = countBySeverity([
    f({ severity: "P0" }), f({ severity: "P1" }), f({ severity: "P1" }), f({ severity: "P3" }),
  ]);
  assert.deepEqual(counts, { p0: 1, p1: 2, p2: 0, p3: 1 });
});

test("countBySeverity on an empty set is all zeroes, not undefined", () => {
  assert.deepEqual(countBySeverity([]), { p0: 0, p1: 0, p2: 0, p3: 0 });
});

test("applyRefutations partitions without losing a finding", () => {
  const findings = [f({ id: "1" }), f({ id: "2" }), f({ id: "3" })];
  const { retained, refuted } = applyRefutations(findings, [
    { finding_id: "2", reason: "guarded above", evidence_file: "a.js", evidence_line: 4 },
  ]);
  assert.deepEqual(retained.map((x) => x.id), ["1", "3"]);
  assert.deepEqual(refuted.map((x) => x.id), ["2"]);
  assert.equal(retained.length + refuted.length, findings.length);
});

test("applyRefutations ignores a refutation whose id matches nothing", () => {
  const { retained, refuted } = applyRefutations([f({ id: "1" })], [
    { finding_id: "nope", reason: "r", evidence_file: "a.js", evidence_line: 1 },
  ]);
  assert.equal(retained.length, 1);
  assert.equal(refuted.length, 0);
});

test("applyRefutations rejects a refutation with no evidence — it is not applied", () => {
  const { retained, refuted } = applyRefutations([f({ id: "1" })], [
    { finding_id: "1", reason: "vibes" },
  ]);
  assert.equal(retained.length, 1, "a refutation without evidence_file/line does not remove a finding");
  assert.equal(refuted.length, 0);
});

test("dedupe records malformed entries rather than dropping them silently", () => {
  const { findings, absorbed, malformed } = dedupe([f({ id: "1" }), null, "nope"]);
  assert.equal(findings.length, 1);
  assert.equal(absorbed.length, 0);
  assert.deepEqual(malformed, [null, "nope"]);
});

test("dedupe conserves every input entry across its three outputs", () => {
  const input = [f({ id: "1", line: 10 }), f({ id: "2", line: 11 }), null];
  const { findings, absorbed, malformed } = dedupe(input);
  assert.equal(findings.length + absorbed.length + malformed.length, input.length);
});
