"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  formatDeterministicContext,
  writeDeterministicContext,
} = require("./write-context.js");

test("formatDeterministicContext: empty manifest is still readable markdown", () => {
  const md = formatDeterministicContext({});
  assert.match(md, /# Review context \(deterministic prep\)/);
  assert.match(md, /review_mode: `full`/);
  assert.match(md, /Empty diff/);
});

test("formatDeterministicContext: lists files, symbols, delta range, and roster", () => {
  const md = formatDeterministicContext(
    {
      review_mode: "delta",
      delta_base_sha: "a".repeat(40),
      head_sha: "b".repeat(40),
      file_count: 2,
      churn: 40,
      total_fullfile_bytes: 1200,
      changed_files: ["src/a.ts", "src/a.test.ts"],
      symbol_manifest: [{ kind: "function", name: "alpha", file: "src/a.ts" }],
      has_logic_change: true,
      has_test_change: true,
      no_tests_for_changed_logic: false,
    },
    {
      k: 1,
      roles: [{ role: "reviewer-1", assigned_files: ["src/a.ts", "src/a.test.ts"] }],
    },
  );
  assert.match(md, /review_mode: `delta`/);
  assert.match(md, /prior published head/);
  assert.match(md, /`src\/a\.ts`/);
  assert.match(md, /\*\*alpha\*\*/);
  assert.match(md, /roster K=1/);
  assert.match(md, /\*\*reviewer-1\*\*/);
  assert.match(md, /Delta mode: must-read/);
});

test("writeDeterministicContext: writes context.md via injectable fs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "write-context-"));
  const out = path.join(dir, "context.md");
  try {
    writeDeterministicContext(
      { review_mode: "full", changed_files: ["x.js"], file_count: 1, churn: 1 },
      { k: 1, roles: [] },
      { path: out },
    );
    const body = fs.readFileSync(out, "utf8");
    assert.match(body, /`x\.js`/);
    assert.match(body, /review_mode: `full`/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
