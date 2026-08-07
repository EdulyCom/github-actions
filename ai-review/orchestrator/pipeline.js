"use strict";

// The round loop.
//
// Every path out of this module is either a complete, publishable review or a
// fail-closed reason. There is no third option: a gate that publishes a
// verdict on an incomplete review is the catastrophic failure this design
// exists to prevent, and three separate paths to it were found in review.
//
//   1. The judge could zero the counts -> the judge no longer emits counts.
//   2. Round-cap exhaustion could publish a clean-looking verdict -> it now
//      returns ok:false and the caller publishes inconclusive.
//   3. A failed Angle H could look like a legitimate exemption -> exemption is
//      an explicit input, never inferred from an empty brief.

const { validatePlan } = require("../lib/plan-schema.js");
const { validateWorkerResult, coverageGaps } = require("../lib/worker-result.js");
const { dedupe, applyRefutations, countBySeverity } = require("../lib/merge.js");
const P = require("./prompts.js");

const READ_ONLY_TOOLS = Object.freeze(["Read", "Grep", "Glob"]);

// The ONLY worker that may execute anything. Today the whole 56-minute review
// session holds this allowlist; confining it to one scoped task is a real
// blast-radius reduction (spec section 5).
const TEST_TOOLS = Object.freeze([
  "Read", "Grep", "Glob",
  "Bash(npm:*)", "Bash(npx:*)", "Bash(yarn:*)", "Bash(pnpm:*)",
  "Bash(pytest:*)", "Bash(make:*)", "Bash(node:*)",
]);

const modelFor = (name, models) => (name === "haiku" ? models.haiku : models.sonnet);

/**
 * @returns {{ok: false, reason: string, output: null, logs: object[], rounds: object[], refuted: object[]}}
 */
const failClosed = (reason, state) => ({
  ok: false, reason, output: null,
  logs: state.logs, rounds: state.rounds, refuted: [],
});

async function runPipeline({ runner, inputs, caps, models, isIntentExempt }) {
  const state = { logs: [], rounds: [] };
  const record = (name, res) => { state.logs.push({ name, log: res.log }); return res; };

  const maxRounds = Number(caps && caps.maxRounds) || 3;
  const maxTasks = Number(caps && caps.maxTasksPerRound) || 12;

  // ---------------------------------------------------------------- Angle H
  //
  // Runs on spec text only, before anything reads the diff. rubric.md:55-60
  // requires framing before code analysis and says re-deriving it afterwards
  // does not count.
  let intentBrief;
  let intentValue;
  if (isIntentExempt) {
    intentBrief = { skipped: true };
    intentValue = "skipped";
  } else {
    const res = record("intent", await runner({
      label: "intent",
      prompt: P.intentPrompt(inputs),
      model: models.opus,
      schema: P.SCHEMAS.intent,
      allowedTools: [],
      retry: true,
    }));
    if (!res.ok) {
      return failClosed(`Angle H (intent brief) failed and this diff is not exempt: ${res.error}`, state);
    }
    intentBrief = res.data;
    intentValue = null; // the judge decides alignment; H only frames
  }

  // ------------------------------------------------------------ collection
  const collectPlan = record("collect-plan", await runner({
    label: "collect-plan",
    prompt: P.collectPlanPrompt({ prepPack: inputs.prepPack, diff: inputs.diff, intentBrief }),
    model: models.opus,
    schema: P.SCHEMAS.plan,
    allowedTools: [],
    retry: true,
  }));
  if (!collectPlan.ok) return failClosed(`collection planning failed: ${collectPlan.error}`, state);

  const collectCheck = validatePlan(collectPlan.data, { maxTasks, requireFloor: false });
  if (!collectCheck.ok) {
    return failClosed(`collection plan invalid: ${collectCheck.violations.join("; ")}`, state);
  }

  const facts = [];
  for (const r of await dispatch("collect", collectPlan.data.tasks)) {
    if (r.ok) facts.push({ task_id: r.result.task_id, findings: r.result.findings, evidence: r.result.evidence });
  }

  // ------------------------------------------------------------ round loop
  let allFindings = [];
  let allEvidence = [];
  let gaps = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    const roundsLeft = maxRounds - round;
    const isFinalRound = roundsLeft === 0;

    // --- plan (one re-prompt on a validation violation, then fail closed)
    let plan = null;
    let violations = null;
    for (let attempt = 0; attempt < 2 && plan === null; attempt += 1) {
      const res = record(`r${round}:test-plan:${attempt}`, await runner({
        label: "test-plan",
        prompt:
          P.testPlanPrompt({
            prepPack: inputs.prepPack, diff: inputs.diff, intentBrief,
            facts, gaps, round, roundsLeft,
          }) +
          (violations
            ? `\n\n## Your previous plan was REJECTED\n${violations.join("\n")}\nFix these and re-emit.`
            : ""),
        model: models.opus,
        schema: P.SCHEMAS.plan,
        allowedTools: [],
        retry: true,
      }));
      if (!res.ok) return failClosed(`planning failed in round ${round}: ${res.error}`, state);

      const check = validatePlan(res.data, { maxTasks });
      if (check.ok) plan = res.data;
      else violations = check.violations;
    }
    if (plan === null) {
      return failClosed(`plan invalid after one re-prompt: ${violations.join("; ")}`, state);
    }

    // --- dispatch
    const settled = await dispatch(`r${round}`, plan.tasks);
    const completed = settled.filter((r) => r.ok).map((r) => r.result);
    for (const r of completed) {
      allFindings = allFindings.concat(r.findings);
      allEvidence = allEvidence.concat(r.evidence);
    }

    gaps = coverageGaps(plan.tasks, completed);
    if (gaps.length > 0 && isFinalRound) {
      return failClosed(
        `floor angle(s) ${gaps.join(", ")} have no completed worker and no rounds remain`,
        state
      );
    }

    // --- merge (deterministic, before the judge sees anything)
    const merged = dedupe(allFindings);

    // --- judge
    const judgeRes = record(`r${round}:judge`, await runner({
      label: "judge",
      prompt: P.judgePrompt({
        findings: merged.findings, evidence: allEvidence, gaps,
        round, roundsLeft, isFinalRound,
      }),
      model: models.opus,
      schema: P.SCHEMAS.judge,
      allowedTools: READ_ONLY_TOOLS,
      retry: true,
    }));
    if (!judgeRes.ok) return failClosed(`judging failed in round ${round}: ${judgeRes.error}`, state);

    const judged = judgeRes.data;
    state.rounds.push({
      round,
      tasks: plan.tasks.length,
      completed: completed.length,
      findings: merged.findings.length,
      gaps,
      more_rounds_needed: judged.more_rounds_needed === true,
    });

    if (judged.more_rounds_needed === true && !isFinalRound) continue;

    if (judged.more_rounds_needed === true && isFinalRound) {
      // The A8 laundering shape, refused. A review the judge declared
      // unfinished must never reach recompute() with clean counts.
      return failClosed(
        `the round cap (${maxRounds}) was reached while the judge still required more work` +
          (judged.why_more_rounds ? `: ${judged.why_more_rounds}` : ""),
        state
      );
    }

    if (gaps.length > 0) {
      return failClosed(`floor angle(s) ${gaps.join(", ")} have no completed worker`, state);
    }

    // --- final output. counts are OURS, not the judge's.
    const { retained, refuted } = applyRefutations(merged.findings, judged.refutations);
    const counts = countBySeverity(retained);

    return {
      ok: true,
      reason: null,
      logs: state.logs,
      rounds: state.rounds,
      refuted,
      output: {
        verdict: judged.review_event === "APPROVE" ? "pass" : "fail",
        confidence: 0,          // recompute() overwrites; present for schema parity
        merge_risk: judged.merge_risk,
        intent: intentValue || judged.intent,
        counts,
        review_event: judged.review_event,
        comment_markdown: judged.comment_markdown,
        tests_failing: judged.tests_failing,
        coverage_below_threshold_on_critical_paths: judged.coverage_below_threshold_on_critical_paths,
        no_tests_for_changed_logic: judged.no_tests_for_changed_logic,
        test_execution: judged.test_execution,
        verification_evidence: judged.verification_evidence || [],
        checklist: judged.checklist || [],
      },
    };
  }

  return failClosed(`the round loop exited without a ruling after ${maxRounds} rounds`, state);

  // ---------------------------------------------------------------- helpers

  /**
   * Fan out one round's tasks. allSettled, never all: a rejected worker must
   * not discard its siblings' completed (and paid-for) results.
   *
   * `prefix` scopes the log name to the round (or "collect") that produced
   * it — Opus can legitimately reuse a task id like "s1" across rounds, and
   * without the prefix a later round's log silently overwrites an earlier
   * round's telemetry.
   */
  async function dispatch(prefix, tasks) {
    const settled = await Promise.allSettled(
      (tasks || []).map(async (task) => {
        const res = record(`${prefix}:worker:${task.id}`, await runner({
          label: `worker:${task.id}`,
          prompt: P.workerPrompt({
            task, diff: inputs.diff, prepPack: inputs.prepPack, intentBrief,
          }),
          model: modelFor(task.model, models),
          schema: P.SCHEMAS.workerResult,
          allowedTools: task.kind === "test" ? TEST_TOOLS : READ_ONLY_TOOLS,
          retry: true,
        }));
        if (!res.ok) return { ok: false, reason: res.error, task };
        return validateWorkerResult(res.data, task);
      })
    );
    return settled.map((s) => (s.status === "fulfilled" ? s.value : { ok: false, reason: String(s.reason) }));
  }
}

module.exports = { runPipeline, READ_ONLY_TOOLS, TEST_TOOLS };
