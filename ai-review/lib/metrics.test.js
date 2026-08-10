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

// --- stall fingerprint -------------------------------------------------------
//
// Six measured stalls share one shape: the stage hangs on its first turn and
// returns num_turns 1, $0, zero tool calls, after ~27.6 min (1647262 /
// 1666947 x2 / 1656307 / 1658923 / 1654722 ms — a 1.2% spread). Detecting it
// structurally means a run says so in its own summary instead of needing a log
// dig, which is how the first five were diagnosed. See issue #43.

const stalledLog = (ms = 1654722) => [
  { type: "system", subtype: "init", model: "claude-sonnet-5" },
  {
    type: "result",
    subtype: "success",
    is_error: true,
    num_turns: 1,
    total_cost_usd: 0,
    duration_ms: ms,
  },
];

test("stall fingerprint: 1 turn, no tools, no cost, ~27.6 min is flagged", () => {
  const m = collectMetrics([{ name: "review", log: stalledLog() }]);
  assert.equal(m.stages.review.stalled, true);
  assert.deepEqual(m.totals.stalledStages, ["review"]);
});

test("stall fingerprint: every measured duration is caught", () => {
  for (const ms of [1647262, 1666947, 1656307, 1658923, 1654722]) {
    const m = collectMetrics([{ name: "context", log: stalledLog(ms) }]);
    assert.equal(m.stages.context.stalled, true, String(ms));
  }
});

test("stall fingerprint: real work is never flagged, however long", () => {
  // 72 turns / 70 tool calls / 10.2 min — a genuine review (run 31320749279).
  const real = logFor({ turns: 72, cost: 5.47, ms: 609067, tools: Array(70).fill("Read") });
  const m = collectMetrics([{ name: "review", log: real }]);
  assert.equal(m.stages.review.stalled, false);
  assert.deepEqual(m.totals.stalledStages, []);
});

test("stall fingerprint: a fast 1-turn failure is not a stall", () => {
  // The retry stage was once observed returning in 143ms with num_turns 1 and
  // $0 — same counts, nothing like the same duration. Not a stall.
  const m = collectMetrics([{ name: "review_retry", log: stalledLog(143) }]);
  assert.equal(m.stages.review_retry.stalled, false);
});

test("stall fingerprint: a skipped stage is not a stall", () => {
  const m = collectMetrics([{ name: "context", log: null }]);
  assert.equal(m.stages.context.stalled, false);
  assert.deepEqual(m.totals.stalledStages, []);
});

test("stall fingerprint: several stalled stages are all named (the lagn shape)", () => {
  const m = collectMetrics([
    { name: "context", log: stalledLog(1666947) },
    { name: "review", log: stalledLog(1666947) },
    { name: "review_retry", log: stalledLog(1666947) },
  ]);
  assert.deepEqual(m.totals.stalledStages, ["context", "review", "review_retry"]);
});

test("renderSummary surfaces a stall rather than burying it in the table", () => {
  const md = renderSummary(collectMetrics([{ name: "review", log: stalledLog() }]));
  assert.match(md, /stall/i);
  assert.match(md, /review/);
});
