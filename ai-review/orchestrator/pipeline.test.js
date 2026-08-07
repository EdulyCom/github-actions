"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { runPipeline } = require("./pipeline.js");

const ALL = ["A", "B", "C", "D", "E", "F", "G"];
const okRes = (data) => ({ ok: true, data, log: [{ type: "result", is_error: false }], error: null });
const badRes = (error) => ({ ok: false, data: null, log: [], error });

const INPUTS = {
  prTitle: "t", prBody: "b", linkedIssues: [], diff: "diff", prepPack: { changed_files: ["a.js"] },
};
const CAPS = { maxRounds: 3, maxTasksPerRound: 12 };
const MODELS = { opus: "claude-opus-5", sonnet: "claude-sonnet-5", haiku: "claude-haiku-4-5" };

const scanTask = (over) => ({
  id: "s1", kind: "scan", angles: ALL, model: "sonnet",
  focus: [], question: "q", rationale: "r", ...over,
});

const workerOut = (over) => ({
  // files_examined must be non-empty for a scan worker: worker-result.js
  // treats a scan that read nothing as a dead worker (Task 4 review finding).
  task_id: "s1", angles: ALL, files_examined: ["a.js"], findings: [], evidence: [],
  sentinel: "complete", ...over,
});

const judgeOut = (over) => ({
  more_rounds_needed: false, refutations: [], intent: "aligned", merge_risk: "low",
  review_event: "APPROVE", comment_markdown: "review", ...over,
});

/** Dispatches canned responses by label; records the order calls were made. */
const fakeRunner = (byLabel, calls) => async (opts) => {
  if (calls) calls.push(opts.label);
  const entry = byLabel[opts.label];
  const value = typeof entry === "function" ? entry(opts) : entry;
  return value || badRes(`no fake for label ${opts.label}`);
};

const happyPath = (over) => ({
  intent: okRes({ goal: "g", acceptance_criteria: [], in_scope: [], out_of_scope: [] }),
  "collect-plan": okRes({ round: 1, rationale: "r", tasks: [] }),
  "test-plan": okRes({ round: 1, rationale: "r", tasks: [scanTask()] }),
  "worker:s1": okRes(workerOut()),
  judge: okRes(judgeOut()),
  ...over,
});

test("happy path: one round, clean diff, publishable output", async () => {
  const res = await runPipeline({ runner: fakeRunner(happyPath()), inputs: INPUTS, caps: CAPS, models: MODELS });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.output.review_event, "APPROVE");
  assert.deepEqual(res.output.counts, { p0: 0, p1: 0, p2: 0, p3: 0 });
});

test("counts come from merge.js, not the judge — the judge cannot author them", async () => {
  const findings = [
    { severity: "P1", file: "a.js", line: 10, defect_class: "d", claim: "c", evidence: "e" },
    { severity: "P0", file: "b.js", line: 20, defect_class: "d2", claim: "c", evidence: "e" },
  ];
  const res = await runPipeline({
    runner: fakeRunner(happyPath({
      "worker:s1": okRes(workerOut({ findings })),
      // A judge that tries to smuggle counts in must have no effect.
      judge: okRes({ ...judgeOut(), counts: { p0: 0, p1: 0, p2: 0, p3: 0 } }),
    })),
    inputs: INPUTS, caps: CAPS, models: MODELS,
  });
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(res.output.counts, { p0: 1, p1: 1, p2: 0, p3: 0 },
    "counts must reflect the real findings, not what the judge claimed");
});

test("a refutation without evidence does not remove a finding", async () => {
  const findings = [{ severity: "P1", file: "a.js", line: 10, defect_class: "d", claim: "c", evidence: "e" }];
  const res = await runPipeline({
    runner: fakeRunner(happyPath({
      "worker:s1": okRes(workerOut({ findings })),
      judge: okRes(judgeOut({ refutations: [{ finding_id: "s1#0", reason: "nah" }] })),
    })),
    inputs: INPUTS, caps: CAPS, models: MODELS,
  });
  assert.deepEqual(res.output.counts, { p0: 0, p1: 1, p2: 0, p3: 0 });
});

test("a refutation WITH evidence removes the finding and reports it as refuted", async () => {
  const findings = [{ severity: "P1", file: "a.js", line: 10, defect_class: "d", claim: "c", evidence: "e" }];
  const res = await runPipeline({
    runner: fakeRunner(happyPath({
      "worker:s1": okRes(workerOut({ findings })),
      judge: okRes(judgeOut({
        refutations: [{ finding_id: "s1#0", reason: "guarded", evidence_file: "a.js", evidence_line: 4 }],
      })),
    })),
    inputs: INPUTS, caps: CAPS, models: MODELS,
  });
  assert.deepEqual(res.output.counts, { p0: 0, p1: 0, p2: 0, p3: 0 });
  assert.equal(res.refuted.length, 1, "refuted findings stay visible to the PR's humans");
});

test("an invalid plan is re-prompted once and the second plan is accepted", async () => {
  const calls = [];
  let planCalls = 0;
  const res = await runPipeline({
    runner: fakeRunner(happyPath({
      "test-plan": () => {
        planCalls += 1;
        return planCalls === 1
          ? okRes({ round: 1, rationale: "r", tasks: [scanTask({ angles: ["A"] })] })
          : okRes({ round: 1, rationale: "r", tasks: [scanTask()] });
      },
    }), calls),
    inputs: INPUTS, caps: CAPS, models: MODELS,
  });
  assert.equal(res.ok, true, res.reason);
  assert.equal(planCalls, 2, "exactly one re-prompt");
});

test("a plan invalid twice fails closed, naming the violation", async () => {
  const res = await runPipeline({
    runner: fakeRunner(happyPath({
      "test-plan": okRes({ round: 1, rationale: "r", tasks: [scanTask({ angles: ["A"] })] }),
    })),
    inputs: INPUTS, caps: CAPS, models: MODELS,
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /floor|missing angle/i);
  assert.equal(res.output, null, "a fail-closed run publishes no verdict");
});

test("a floor angle with no completed worker fails closed", async () => {
  const res = await runPipeline({
    runner: fakeRunner(happyPath({ "worker:s1": badRes("subprocess died") })),
    inputs: INPUTS, caps: CAPS, models: MODELS,
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /A|coverage|gap/i);
  assert.equal(res.output, null);
});

test("a worker returning no sentinel is a dead worker, not a clean angle", async () => {
  const noSentinel = workerOut();
  delete noSentinel.sentinel;
  const res = await runPipeline({
    runner: fakeRunner(happyPath({ "worker:s1": okRes(noSentinel) })),
    inputs: INPUTS, caps: CAPS, models: MODELS,
  });
  assert.equal(res.ok, false, "a sentinel-less result must not read as 'nothing found'");
});

test("one dead worker does not discard its siblings' completed work", async () => {
  const findings = [{ severity: "P2", file: "b.js", line: 1, defect_class: "d", claim: "c", evidence: "e" }];
  const res = await runPipeline({
    runner: fakeRunner(happyPath({
      "test-plan": okRes({ round: 1, rationale: "r", tasks: [
        scanTask({ id: "s1", angles: ["A", "B", "C", "D", "E", "F", "G"] }),
        scanTask({ id: "s2", angles: ["A"] }),
      ] }),
      "worker:s1": okRes(workerOut({ task_id: "s1", findings })),
      "worker:s2": badRes("died"),
    })),
    inputs: INPUTS, caps: CAPS, models: MODELS,
  });
  assert.equal(res.ok, true, "s1 covers the whole floor, so s2's death is not a gap");
  assert.deepEqual(res.output.counts, { p0: 0, p1: 0, p2: 1, p3: 0 },
    "s1's paid-for findings survive s2's rejection");
});

test("round-cap exhaustion while the judge wants more fails closed and never approves", async () => {
  const res = await runPipeline({
    runner: fakeRunner(happyPath({
      judge: okRes(judgeOut({ more_rounds_needed: true, why_more_rounds: "unresolved" })),
    })),
    inputs: INPUTS, caps: { maxRounds: 1, maxTasksPerRound: 12 }, models: MODELS,
  });
  assert.equal(res.ok, false, "an unfinished review must not publish a verdict");
  assert.equal(res.output, null);
  assert.match(res.reason, /round/i);
});

test("the judge asking for another round runs one, then finishes", async () => {
  let judgeCalls = 0;
  const res = await runPipeline({
    runner: fakeRunner(happyPath({
      judge: () => {
        judgeCalls += 1;
        return okRes(judgeOut({ more_rounds_needed: judgeCalls === 1 }));
      },
    })),
    inputs: INPUTS, caps: { maxRounds: 3, maxTasksPerRound: 12 }, models: MODELS,
  });
  assert.equal(res.ok, true, res.reason);
  assert.equal(judgeCalls, 2);
  assert.equal(res.rounds.length, 2, "per-round telemetry is recorded");
});

test("Angle H failing on a non-exempt diff fails closed", async () => {
  const res = await runPipeline({
    runner: fakeRunner(happyPath({ intent: badRes("flake") })),
    inputs: INPUTS, caps: CAPS, models: MODELS,
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /intent|angle h/i);
});

test("an exempt diff skips H explicitly rather than inferring it from an empty brief", async () => {
  const calls = [];
  const res = await runPipeline({
    runner: fakeRunner(happyPath(), calls),
    inputs: INPUTS, caps: CAPS, models: MODELS, isIntentExempt: true,
  });
  assert.equal(res.ok, true, res.reason);
  assert.ok(!calls.includes("intent"), "no intent call is made for an exempt diff");
  assert.equal(res.output.intent, "skipped");
});

test("the judge and planner run on the pinned Opus model, workers on their assigned model", async () => {
  const seen = {};
  const runner = async (opts) => {
    seen[opts.label] = opts.model;
    const table = happyPath();
    const entry = table[opts.label];
    return typeof entry === "function" ? entry(opts) : entry;
  };
  await runPipeline({ runner, inputs: INPUTS, caps: CAPS, models: MODELS });
  assert.equal(seen.intent, "claude-opus-5");
  assert.equal(seen["test-plan"], "claude-opus-5");
  assert.equal(seen.judge, "claude-opus-5");
  assert.equal(seen["worker:s1"], "claude-sonnet-5");
});

test("only a test-kind worker receives an exec allowlist", async () => {
  const seen = {};
  const runner = async (opts) => {
    seen[opts.label] = opts.allowedTools;
    const table = happyPath({
      "test-plan": okRes({ round: 1, rationale: "r", tasks: [
        scanTask({ id: "s1", angles: ALL }),
        { id: "x1", kind: "test", angles: [], model: "sonnet", focus: [], question: "q", rationale: "r" },
      ] }),
      "worker:x1": okRes(workerOut({ task_id: "x1", angles: [] })),
    });
    const entry = table[opts.label];
    return typeof entry === "function" ? entry(opts) : entry;
  };
  await runPipeline({ runner, inputs: INPUTS, caps: CAPS, models: MODELS });
  assert.ok(!seen["worker:s1"].some((t) => t.startsWith("Bash")), "scan workers are read-only");
  assert.ok(seen["worker:x1"].some((t) => t.startsWith("Bash")), "the one test worker holds exec");
});

test("logs are collected per stage for telemetry", async () => {
  const res = await runPipeline({ runner: fakeRunner(happyPath()), inputs: INPUTS, caps: CAPS, models: MODELS });
  const names = res.logs.map((l) => l.name);
  assert.ok(names.includes("intent"));
  assert.ok(names.some((n) => n.endsWith("judge")));
  assert.ok(names.some((n) => n.includes("worker:")));
});

test("log names are unique per round so a later round cannot overwrite an earlier one", async () => {
  let judgeCalls = 0;
  const res = await runPipeline({
    runner: fakeRunner(happyPath({
      judge: () => {
        judgeCalls += 1;
        return okRes(judgeOut({ more_rounds_needed: judgeCalls === 1 }));
      },
    })),
    inputs: INPUTS, caps: { maxRounds: 3, maxTasksPerRound: 12 }, models: MODELS,
  });
  assert.equal(res.ok, true, res.reason);
  const names = res.logs.map((l) => l.name);
  assert.equal(new Set(names).size, names.length,
    `duplicate log names would silently overwrite telemetry: ${names.join(", ")}`);
  assert.equal(names.filter((n) => n.endsWith("judge")).length, 2,
    "a two-round review must produce two distinct judge logs");
});
