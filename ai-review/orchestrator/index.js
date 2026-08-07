"use strict";

// Orchestrator entry point.
//
// Thin by design: every decision worth testing lives in lib/ or pipeline.js.
// This file reads the environment, runs the pipeline, and writes three things:
//
//   1. structured_output  — the publish step's input (empty on fail-closed, so
//      publish degrades to its existing inconclusive path unchanged)
//   2. per-stage logs     — RUNNER_TEMP files the telemetry step parses with
//      lib/metrics.js, which needs no change
//   3. failed_reason      — human-readable, surfaced in the step summary

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { query } = require("@anthropic-ai/claude-agent-sdk");

const { createRunner } = require("./session.js");
const { runPipeline } = require("./pipeline.js");
const { isIntentExempt } = require("../lib/diff-class.js");
const { unusablePrep } = require("../lib/prep-guard.js");

const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
};

const readText = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

const setOutput = (name, value) => {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const str = String(value);
  // Heredoc form: model output is multi-line and must never be shell-expanded.
  // The delimiter must be unpredictable and checked against the body — a
  // value that is rejected precisely because it violates a format pattern
  // (e.g. a task id) can still contain newlines, and an attacker-shaped body
  // must never be able to forge its own terminator line.
  let delim = `EOF_${name}_${crypto.randomUUID()}`;
  if (str.includes(delim)) delim = `EOF_${name}_${crypto.randomUUID()}`;
  if (str.includes(delim)) {
    // Still collides (should not happen twice) — never emit a heredoc whose
    // body contains its own terminator. Strip newlines instead.
    fs.appendFileSync(file, `${name}<<${delim}\n${str.replace(/\r?\n/g, " ")}\n${delim}\n`);
    return;
  }
  fs.appendFileSync(file, `${name}<<${delim}\n${str}\n${delim}\n`);
};

// The single fail-closed exit. An empty structured_output is exactly what the
// existing publish step already handles: it posts the inconclusive comment and
// does not pass the gate. The reason file is what publish quotes back.
const failClosed = (reason) => {
  console.error(`ai-review orchestrator failed closed: ${reason}`);
  setOutput("structured_output", "");
  setOutput("failed_reason", reason);
  fs.mkdirSync(".ai-review", { recursive: true });
  fs.writeFileSync(".ai-review/orchestrator-reason.txt", reason);
  process.exit(0); // the step succeeds; publish decides the verdict
};

(async () => {
  const prepPack = readJson(".ai-review/context-pack.json", {});
  const diff = readText(".ai-review/diff.patch");
  const linkedIssues = readJson(".ai-review/linked-issues.json", []);
  // Title/body come from a file, never an env var: a PR body is fully
  // attacker-controlled multiline text, and routing it through
  // $GITHUB_OUTPUT/env would recreate the heredoc-forgery hole already
  // fixed for structured output (see setOutput above). The "Resolve PR
  // title and body" action.yml step writes this via `gh pr view` redirected
  // straight to a file — never interpolated into a shell command.
  const pr = readJson(".ai-review/pr.json", {});

  // Fail closed BEFORE a runner exists, so not one paid model call is made on
  // inputs that cannot support a review. lib/prep-guard.js explains why an
  // unvalidated empty diff produces a confident PASS rather than an error.
  const prepDefect = unusablePrep(prepPack, diff);
  if (prepDefect) {
    failClosed(
      "the deterministic prep step did not produce a usable diff or context pack " +
        `(${prepDefect}), so the review could not begin. This is not a code-quality ` +
        'judgment — check the "Build diff and context pack" step\'s log (it is ' +
        "continue-on-error, so it can fail red while the job continues) and re-run."
    );
    return;
  }

  const caps = {
    maxRounds: Number(process.env.MAX_ROUNDS) || 3,
    maxTasksPerRound: Number(process.env.MAX_TASKS_PER_ROUND) || 12,
  };
  const models = {
    opus: process.env.ORCHESTRATOR_MODEL || "claude-opus-5",
    sonnet: process.env.SONNET_MODEL || "claude-sonnet-5",
    haiku: process.env.HAIKU_MODEL || "claude-haiku-4-5",
  };

  const runner = createRunner({
    query,
    cwd: process.cwd(),
    timeoutMs: (Number(process.env.WORKER_TIMEOUT_MINUTES) || 10) * 60 * 1000,
    maxTurns: Number(process.env.WORKER_MAX_TURNS) || 60,
  });

  const result = await runPipeline({
    runner,
    caps,
    models,
    isIntentExempt: isIntentExempt(prepPack.changed_files),
    inputs: {
      prTitle: pr.title || "",
      prBody: pr.body || "",
      linkedIssues,
      diff,
      prepPack,
      // Caller-supplied test guidance. Only the single `kind: "test"` worker —
      // the one holding the exec allowlist — is shown these.
      testCommand: process.env.TEST_COMMAND || "",
      testHint: process.env.TEST_HINT || "",
    },
  });

  // Per-stage logs for the telemetry step. One file per stage, named so the
  // step can collect them without knowing the plan's shape in advance.
  const logDir = path.join(process.env.RUNNER_TEMP || ".", "ai-review-logs");
  fs.mkdirSync(logDir, { recursive: true });
  for (const { name, log } of result.logs) {
    const safe = name.replace(/[^a-zA-Z0-9_.-]/g, "_");
    fs.writeFileSync(path.join(logDir, `${safe}.json`), JSON.stringify(log));
  }
  fs.writeFileSync(
    path.join(logDir, "_rounds.json"),
    JSON.stringify({ rounds: result.rounds, ok: result.ok, reason: result.reason })
  );

  if (!result.ok) {
    failClosed(result.reason);
    return;
  }

  // Refuted findings stay visible to the PR's humans rather than vanishing.
  if (result.refuted.length > 0) {
    const rows = result.refuted
      .map((f) => `- **${f.severity}** \`${f.file}:${f.line}\` — ${f.claim}`)
      .join("\n");
    result.output.comment_markdown +=
      `\n\n<details><summary>Refuted during judging (${result.refuted.length})</summary>\n\n${rows}\n\n</details>`;
  }

  const json = JSON.stringify(result.output);
  fs.mkdirSync(".ai-review", { recursive: true });
  fs.writeFileSync(".ai-review/orchestrator-output.json", json);
  setOutput("structured_output", json);
})().catch((err) => {
  // An orchestrator crash must still land on the fail-closed path. Even if
  // setOutput itself throws (e.g. an unwritable GITHUB_OUTPUT), this step
  // must still exit 0 so publish is never left guessing.
  console.error(`ai-review orchestrator crashed: ${err && err.stack}`);
  try {
    setOutput("structured_output", "");
    setOutput("failed_reason", `orchestrator crashed: ${err && err.message}`);
  } catch {}
  process.exit(0);
});
