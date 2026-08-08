"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  extractDeclaredIds,
  extractReferencedIds,
  findDuplicateIds,
  findDanglingRefs,
} = require("./action-refs.js");

const FIXTURE_OK = `
runs:
  using: composite
  steps:
    - name: First
      id: first
      run: echo hi
    - name: Second
      id: second
      if: steps.first.outputs.x == 'y'
      run: echo \${{ steps.first.outputs.x }}
`;

const FIXTURE_DUPLICATE = `
runs:
  using: composite
  steps:
    - name: First
      id: dup
      run: echo hi
    - name: Second
      id: dup
      run: echo bye
`;

const FIXTURE_DANGLING = `
runs:
  using: composite
  steps:
    - name: Only
      id: only
      if: steps.ghost.outputs.x == 'y'
      run: echo hi
`;

const FIXTURE_HYPHEN_UNDERSCORE_IDS = `
runs:
  using: composite
  steps:
    - name: Fork guard
      id: fork-guard
      run: echo hi
    - name: Review retry
      id: review_retry
      if: steps.fork-guard.outputs.x == 'y' && steps.review_retry.outcome == 'z'
      run: echo bye
`;

// --- extractDeclaredIds -----------------------------------------------------

test("extractDeclaredIds finds every 6-space-indented id: line", () => {
  assert.deepEqual(extractDeclaredIds(FIXTURE_OK), ["first", "second"]);
});

test("extractDeclaredIds handles hyphens and underscores in ids", () => {
  assert.deepEqual(extractDeclaredIds(FIXTURE_HYPHEN_UNDERSCORE_IDS), [
    "fork-guard",
    "review_retry",
  ]);
});

// --- extractReferencedIds ---------------------------------------------------

test("extractReferencedIds finds steps.<id>. usages, deduped", () => {
  assert.deepEqual(extractReferencedIds(FIXTURE_OK), ["first"]);
});

test("extractReferencedIds matches steps.<id>.outcome as well as .outputs.", () => {
  const referenced = extractReferencedIds(FIXTURE_HYPHEN_UNDERSCORE_IDS);
  assert.ok(referenced.includes("fork-guard"));
  assert.ok(referenced.includes("review_retry"));
});

// --- findDuplicateIds --------------------------------------------------------

test("findDuplicateIds is empty on a clean fixture", () => {
  assert.deepEqual(findDuplicateIds(FIXTURE_OK), []);
});

test("findDuplicateIds catches a repeated id", () => {
  assert.deepEqual(findDuplicateIds(FIXTURE_DUPLICATE), ["dup"]);
});

// --- findDanglingRefs --------------------------------------------------------

test("findDanglingRefs is empty on a clean fixture", () => {
  assert.deepEqual(findDanglingRefs(FIXTURE_OK), []);
});

test("findDanglingRefs catches a reference to a step that was never declared", () => {
  assert.deepEqual(findDanglingRefs(FIXTURE_DANGLING), ["ghost"]);
});

// --- Integration: the real production file -----------------------------------

test("ai-review/action.yml has no duplicate step ids", () => {
  const yamlText = fs.readFileSync(
    path.join(__dirname, "..", "action.yml"),
    "utf8"
  );
  assert.deepEqual(findDuplicateIds(yamlText), []);
});

test("ai-review/action.yml has no dangling steps.<id>. references", () => {
  const yamlText = fs.readFileSync(
    path.join(__dirname, "..", "action.yml"),
    "utf8"
  );
  assert.deepEqual(findDanglingRefs(yamlText), []);
});
