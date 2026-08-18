"use strict";

// Per-stage telemetry for the ai-review pipeline.
//
// Every phase gate in the parallel-review migration is a number this module
// produces, rather than a judgment. That matters because the two
// measurement errors that shaped that program both came from grepping logs
// instead of parsing them:
//
//   1. A 22-entry `--allowedTools` allowlist, echoed three times in the action's
//      inputs dump, was read as "66 Bash tool calls". Only `tool_use` content
//      blocks are counted here — never text.
//   2. `head -1` over a job log reported the Context stage's 36 turns / $0.31
//      as the Review stage's figures (actually 138 turns / $31.01). Stages are
//      attributed explicitly here and never merged.
//
// Pure: no I/O, no process.env. The caller reads and JSON.parses the execution
// logs; claude-code-action writes them to `${RUNNER_TEMP}/claude-execution-output.json`
// (a shared path — the action snapshots each stage's copy before the next
// invocation overwrites it).

/** Shape of a stage that produced no log at all (skipped step). */
const NOT_RUN = Object.freeze({
  ran: false,
  ok: false,
  turns: null,
  costUsd: null,
  durationMs: null,
  model: null,
  numToolCalls: 0,
  toolCalls: {},
  stalled: false,
});

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// A stalled stage hangs on its first turn and returns having done nothing.
// Six measured occurrences (issue #43) cluster at ~27.6 min: 1647262, 1666947
// x2, 1656307, 1658923, 1654722 ms — a 1.2% spread across three repos, two
// model IDs and both the context and review stages.
//
// The duration floor is what separates a stall from an ordinary fast failure:
// the retry stage was once observed returning in 143 ms with the same
// num_turns 1 / $0 counts. 15 min sits far above any real 1-turn response and
// far below the observed cluster, so neither side is ambiguous.
const STALL_MIN_MS = 900000;

function isStalled(stage) {
  return (
    stage.ran === true &&
    (stage.turns === null || stage.turns <= 1) &&
    stage.numToolCalls === 0 &&
    (stage.costUsd === null || stage.costUsd === 0) &&
    typeof stage.durationMs === "number" &&
    stage.durationMs >= STALL_MIN_MS
  );
}

/**
 * @param {unknown} entries parsed execution log — a top-level array of stream
 *   entries terminated by a `result` entry.
 * @returns {{ran: boolean, ok: boolean, turns: number|null, costUsd: number|null,
 *   durationMs: number|null, model: string|null, numToolCalls: number,
 *   toolCalls: Record<string, number>}}
 */
function parseExecutionLog(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ...NOT_RUN, ran: Array.isArray(entries) };
  }

  // Last result wins: a log may carry more than one (e.g. a resumed session).
  let result = null;
  let model = null;
  const toolCalls = {};

  for (const e of entries) {
    if (!e || typeof e !== "object") continue;

    if (e.type === "result") result = e;

    // Prefer the init entry's model, but accept any entry that names one.
    if (model === null && typeof e.model === "string") model = e.model;

    // Tool invocations are `tool_use` content blocks on assistant messages.
    // A tool NAME appearing in a `text` block is prose, not an invocation.
    const content = e.message && e.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === "tool_use" && typeof block.name === "string") {
          toolCalls[block.name] = (toolCalls[block.name] || 0) + 1;
        }
      }
    }
  }

  const numToolCalls = Object.values(toolCalls).reduce((a, b) => a + b, 0);

  if (!result) {
    return { ...NOT_RUN, ran: true, toolCalls, numToolCalls };
  }

  return {
    ran: true,
    // A result with is_error, or a non-success subtype, still carries real
    // numbers worth recording — but must not read as a healthy stage.
    ok: result.is_error !== true && result.subtype !== "error_during_execution",
    turns: num(result.num_turns),
    costUsd: num(result.total_cost_usd),
    durationMs: num(result.duration_ms),
    model,
    numToolCalls,
    toolCalls,
  };
}

/**
 * @param {{name: string, log: unknown}[]} stages in pipeline order.
 */
function collectMetrics(stages) {
  const out = { stages: {}, totals: {} };
  const list = Array.isArray(stages) ? stages : [];

  for (const { name, log } of list) {
    const stage = log == null ? { ...NOT_RUN } : parseExecutionLog(log);
    stage.stalled = isStalled(stage);
    out.stages[name] = stage;
  }

  const ran = Object.values(out.stages).filter((s) => s.ran);
  const sum = (k) => ran.reduce((a, s) => a + (s[k] || 0), 0);

  const durationMs = sum("durationMs");
  let dominantStage = null;
  let dominantShare = null;
  for (const [name, s] of Object.entries(out.stages)) {
    if (!s.ran || !s.durationMs) continue;
    if (dominantStage === null || s.durationMs > out.stages[dominantStage].durationMs) {
      dominantStage = name;
    }
  }
  if (dominantStage && durationMs > 0) {
    dominantShare = Math.round(
      (out.stages[dominantStage].durationMs / durationMs) * 100
    );
  }

  out.totals = {
    turns: sum("turns"),
    costUsd: sum("costUsd"),
    durationMs,
    numToolCalls: sum("numToolCalls"),
    dominantStage,
    dominantShare,
    stalledStages: Object.entries(out.stages)
      .filter(([, s]) => s.stalled)
      .map(([name]) => name),
  };
  return out;
}

/** `3363956` -> `"56m 04s"`. */
function formatDuration(ms) {
  if (ms == null) return "—";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

const formatCost = (c) => (c == null ? "—" : `$${c.toFixed(2)}`);

/** Markdown table for $GITHUB_STEP_SUMMARY. */
function renderSummary(metrics) {
  const rows = Object.entries(metrics.stages).map(([name, s]) =>
    s.ran
      ? `| ${name} | ${s.turns ?? "—"} | ${formatCost(s.costUsd)} | ${formatDuration(s.durationMs)} | ${s.model || "—"} | ${s.numToolCalls} |`
      : `| ${name} | _skipped_ | — | — | — | — |`
  );

  const t = metrics.totals;
  const dominant =
    t.dominantStage && t.dominantShare != null
      ? `\n\n> Dominant stage: **${t.dominantStage}** — ${t.dominantShare}% of pipeline wall-clock.`
      : "";

  // A stall is called out above the table, not left to be inferred from a row
  // reading "1 turn / $0 / 27m". The first five were each diagnosed by digging
  // through raw runner logs; this makes the run say it itself. See issue #43.
  const stall =
    t.stalledStages && t.stalledStages.length > 0
      ? `\n\n> **Stalled: ${t.stalledStages.join(", ")}.** Hung on the first turn and returned` +
        " no work (1 turn, $0, zero tool calls, >15 min). This is the gateway stall tracked in" +
        " issue #43 — not a code-quality result. Re-run."
      : "";

  return (
    [
      "### ai-review telemetry",
      "",
      "| stage | turns | cost | duration | model | tool calls |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rows,
      `| **total** | **${t.turns}** | **${formatCost(t.costUsd)}** | **${formatDuration(t.durationMs)}** | | **${t.numToolCalls}** |`,
    ].join("\n") +
    stall +
    dominant
  );
}

/**
 * Prefer the first execution log that names a model (retry → repair → review
 * order is the caller's responsibility). Fall back to the routed primary when
 * logs are missing or silent.
 * @param {{logs: unknown[], fallback: string}} args
 * @returns {string}
 */
function resolveModelUsed({ logs, fallback }) {
  for (const log of logs || []) {
    const m = parseExecutionLog(log).model;
    if (typeof m === "string" && m.trim()) return m.trim();
  }
  return typeof fallback === "string" ? fallback : "";
}

module.exports = {
  parseExecutionLog,
  collectMetrics,
  renderSummary,
  formatDuration,
  isStalled,
  STALL_MIN_MS,
  resolveModelUsed,
};
