"use strict";

// Per-stage telemetry for the ai-review pipeline.
//
// Every phase gate in docs/superpowers/plans/2026-08-06-ai-review-time-and-quality.md
// is a number this module produces, rather than a judgment. That matters
// because the two measurement errors that shaped this program both came from
// grepping logs instead of parsing them:
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
// (a shared path — the action snapshots the review stage's copy before the
// repair/retry stages overwrite it).

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
});

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

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
    out.stages[name] = log == null ? { ...NOT_RUN } : parseExecutionLog(log);
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

  return [
    "### ai-review telemetry",
    "",
    "| stage | turns | cost | duration | model | tool calls |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    `| **total** | **${t.turns}** | **${formatCost(t.costUsd)}** | **${formatDuration(t.durationMs)}** | | **${t.numToolCalls}** |`,
  ].join("\n") + dominant;
}

module.exports = { parseExecutionLog, collectMetrics, renderSummary, formatDuration };
