"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { unusablePrep } = require("./prep-guard.js");

const DIFF = "diff --git a/a.js b/a.js\n+const x = 1;";
const pack = (over) => ({
  head_sha: "a".repeat(40),
  base_sha: "b".repeat(40),
  default_branch: "main",
  changed_files: ["a.js"],
  churn: 1,
  ...over,
});

test("accepts a well-formed prep pack and a real diff", () => {
  assert.equal(unusablePrep(pack(), DIFF), null);
});

test("rejects an empty diff — the prep step failed and the job continued", () => {
  assert.match(String(unusablePrep(pack(), "")), /diff/);
});

test("rejects a whitespace-only diff", () => {
  assert.match(String(unusablePrep(pack(), "\n  \t\n")), /diff/);
});

test("rejects a missing diff without throwing", () => {
  assert.ok(unusablePrep(pack(), undefined));
  assert.ok(unusablePrep(pack(), null));
});

test("rejects a pack with no head_sha or no base_sha, naming which", () => {
  assert.match(String(unusablePrep(pack({ head_sha: "" }), DIFF)), /head_sha/);
  assert.match(String(unusablePrep(pack({ base_sha: "   " }), DIFF)), /base_sha/);
  const noHead = pack();
  delete noHead.head_sha;
  assert.match(String(unusablePrep(noHead, DIFF)), /head_sha/);
});

test("rejects a pack whose changed_files is empty or not an array", () => {
  assert.match(String(unusablePrep(pack({ changed_files: [] }), DIFF)), /changed files/);
  assert.match(String(unusablePrep(pack({ changed_files: "a.js" }), DIFF)), /changed files/);
});

test("rejects the empty-object fallback index.js uses for a missing pack", () => {
  assert.ok(unusablePrep({}, DIFF), "a missing context-pack.json must not read as usable");
});

test("rejects a non-object pack without throwing", () => {
  assert.ok(unusablePrep(null, DIFF));
  assert.ok(unusablePrep([], DIFF));
  assert.ok(unusablePrep("{}", DIFF));
});

test("the empty-diff check runs before the pack is dereferenced", () => {
  // index.js calls this with whatever JSON.parse returned; a null pack and an
  // empty diff together must still produce a reason, never a TypeError.
  assert.doesNotThrow(() => unusablePrep(null, ""));
});
