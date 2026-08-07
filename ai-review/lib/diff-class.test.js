"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isIntentExempt } = require("./diff-class.js");

test("a docs-only diff is exempt from Angle H", () => {
  assert.equal(isIntentExempt(["README.md", "docs/guide.md"]), true);
});

test("a diff with any code file is not exempt", () => {
  assert.equal(isIntentExempt(["README.md", "src/index.js"]), false);
});

test("workflow and action YAML is NOT exempt — it is logic", () => {
  assert.equal(isIntentExempt([".github/workflows/ci.yml"]), false);
});

test("an empty file list is not exempt — absence of evidence is not exemption", () => {
  assert.equal(isIntentExempt([]), false);
});

test("non-array input is not exempt rather than throwing", () => {
  assert.equal(isIntentExempt(null), false);
  assert.equal(isIntentExempt("README.md"), false);
});

test("lockfiles and generated manifests alone are exempt", () => {
  assert.equal(isIntentExempt(["package-lock.json", "CHANGELOG.md"]), true);
});
