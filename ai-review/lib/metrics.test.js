"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseExecutionLog, collectMetrics, renderSummary } = require("./metrics.js");

// A minimal execution log in claude-code-action's shape: a top-level array of
// stream entries, terminated by a `result` entry. The shape is pinned by the
// action's own salvage step, which walks it as `.[]? | select(.type == ...)`
// and reads `.message.content[]?` off assistant entries.
const logFor = ({ turns, cost, ms, model = "claude-opus-4-8", tools = [] }) => [
  { type: "system", subtype: "init", model },
  ...tools.map((name) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", name }] },
  })),
  {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: turns,
    total_cost_usd: cost,
    duration_ms: ms,
  },
];

// --- parseExecutionLog -----------------------------------------------------

test("parses turns, cost, and duration from a result entry", () => {
  // Real values from EdulyCom/eduly job 92446725669's Review stage.
  const m = parseExecutionLog(
    logFor({ turns: 138, cost: 31.008854, ms: 3363956 })
  );
  assert.equal(m.turns, 138);
  assert.equal(m.costUsd, 31.008854);
  assert.equal(m.durationMs, 3363956);
  assert.equal(m.model, "claude-opus-4-8");
});

test("counts tool calls by name from tool_use blocks", () => {
  const m = parseExecutionLog(
    logFor({ turns: 3, cost: 0.1, ms: 100, tools: ["Bash", "Bash", "Read"] })
  );
  assert.deepEqual(m.toolCalls, { Bash: 2, Read: 1 });
  assert.equal(m.numToolCalls, 3);
});

test("does NOT count tool names that appear only in text", () => {
  // Guard for the measurement error this module exists to prevent: a 22-entry
  // --allowedTools allowlist echoed in the log was once read as "66 Bash tool
  // calls". Only tool_use blocks are invocations.
  const m = parseExecutionLog([
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: 'allowedTools "Bash(git diff:*),Bash(cat:*)"' },
        ],
      },
    },
    { type: "result", num_turns: 1, total_cost_usd: 0.01, duration_ms: 10 },
  ]);
  assert.equal(m.numToolCalls, 0);
  assert.deepEqual(m.toolCalls, {});
});

test("a missing result entry yields nulls, not a throw", () => {
  const m = parseExecutionLog([{ type: "system", subtype: "init" }]);
  assert.equal(m.turns, null);
  assert.equal(m.costUsd, null);
  assert.equal(m.durationMs, null);
  assert.equal(m.ok, false);
});

test("tolerates a null, empty, or non-array log", () => {
  for (const bad of [null, undefined, [], {}, "nonsense"]) {
    const m = parseExecutionLog(bad);
    assert.equal(m.turns, null, `input ${JSON.stringify(bad)}`);
    assert.equal(m.ok, false);
  }
});

test("reports an errored result as not ok while keeping its numbers", () => {
  const m = parseExecutionLog([
    {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      num_turns: 1,
      total_cost_usd: 0,
      duration_ms: 143,
    },
  ]);
  assert.equal(m.ok, false);
  assert.equal(m.turns, 1);
  assert.equal(m.durationMs, 143);
});

test("reads the last result entry when several are present", () => {
  const m = parseExecutionLog([
    { type: "result", num_turns: 1, total_cost_usd: 0.5, duration_ms: 10 },
    { type: "result", num_turns: 9, total_cost_usd: 2.5, duration_ms: 90 },
  ]);
  assert.equal(m.turns, 9);
});

// --- collectMetrics --------------------------------------------------------

test("keeps stages separately attributed and never conflates them", () => {
  // Guard for the second measurement error: `head -1` over a job log reported
  // the Context stage's 36 turns / $0.31 as the Review stage's figures. Real
  // values from job 92446725669.
  const out = collectMetrics([
    { name: "context", log: logFor({ turns: 36, cost: 0.31, ms: 178000, model: "claude-haiku-4-5-20251001" }) },
    { name: "review", log: logFor({ turns: 138, cost: 31.008854, ms: 3363956 }) },
  ]);
  assert.equal(out.stages.context.turns, 36);
  assert.equal(out.stages.review.turns, 138);
  assert.equal(out.stages.context.model, "claude-haiku-4-5-20251001");
  assert.equal(out.stages.review.model, "claude-opus-4-8");
});

test("totals sum across stages and ignore absent ones", () => {
  const out = collectMetrics([
    { name: "context", log: logFor({ turns: 36, cost: 0.31, ms: 178000 }) },
    { name: "review", log: logFor({ turns: 138, cost: 31.008854, ms: 3363956 }) },
    { name: "review_retry", log: null },
  ]);
  assert.equal(out.totals.turns, 174);
  assert.equal(out.totals.costUsd.toFixed(4), "31.3189");
  assert.equal(out.totals.durationMs, 3541956);
  assert.equal(out.stages.review_retry.ran, false);
});

test("a stage with no log is recorded as not-run rather than omitted", () => {
  // The repair/retry/salvage chain is skipped on the happy path. "Skipped" and
  // "ran but produced nothing" must stay distinguishable.
  const out = collectMetrics([{ name: "review_repair", log: null }]);
  assert.equal(out.stages.review_repair.ran, false);
  assert.equal(out.stages.review_repair.turns, null);
});

test("dominant stage is identified by duration", () => {
  const out = collectMetrics([
    { name: "context", log: logFor({ turns: 36, cost: 0.31, ms: 178000 }) },
    { name: "review", log: logFor({ turns: 138, cost: 31.0, ms: 3363956 }) },
  ]);
  assert.equal(out.totals.dominantStage, "review");
  assert.equal(out.totals.dominantShare, 95);
});

// --- renderSummary ---------------------------------------------------------

test("summary renders one row per stage with a totals line", () => {
  const md = renderSummary(
    collectMetrics([
      { name: "context", log: logFor({ turns: 36, cost: 0.31, ms: 178000 }) },
      { name: "review", log: logFor({ turns: 138, cost: 31.0, ms: 3363956 }) },
      { name: "review_retry", log: null },
    ])
  );
  assert.match(md, /\| context \|/);
  assert.match(md, /\| review \|/);
  assert.match(md, /skipped/);
  assert.match(md, /138/);
  assert.match(md, /56m 04s/);
  assert.match(md, /\$31\.00/);
});
