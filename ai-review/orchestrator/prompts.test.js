"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  intentPrompt, collectPlanPrompt, testPlanPrompt, workerPrompt, judgePrompt, SCHEMAS,
} = require("./prompts.js");

const DIFF = "diff --git a/secret.js b/secret.js\n+const x = 1;";
const BRIEF = { goal: "g", acceptance_criteria: ["ac"], in_scope: ["a.js"], out_of_scope: [] };

test("intentPrompt never contains the diff — rubric.md:55-60 requires framing first", () => {
  const p = intentPrompt({ prTitle: "t", prBody: "b", linkedIssues: [{ number: 1, title: "i", body: "ib" }] });
  assert.ok(!p.includes(DIFF), "the intent call must not see diff content");
  assert.ok(!p.toLowerCase().includes("diff --git"));
  assert.ok(p.includes("t") && p.includes("b"), "it does see PR title and body");
});

test("intentPrompt forbids emitting findings — H hands forward a brief, not verdicts", () => {
  const p = intentPrompt({ prTitle: "t", prBody: "b", linkedIssues: [] });
  assert.match(p, /not.*(finding|verdict|severity)/i);
});

test("workerPrompt contains the FULL diff — scope is focus, not blinders", () => {
  const p = workerPrompt({
    task: { id: "t1", kind: "scan", angles: ["B"], focus: ["a.js"], question: "q" },
    diff: DIFF, prepPack: { changed_files: ["a.js"] }, intentBrief: BRIEF,
  });
  assert.ok(p.includes(DIFF), "cross-shard interactions are invisible without the whole diff");
});

test("workerPrompt states the sentinel requirement explicitly", () => {
  const p = workerPrompt({
    task: { id: "t1", kind: "scan", angles: ["B"], focus: ["a.js"], question: "q" },
    diff: DIFF, prepPack: {}, intentBrief: BRIEF,
  });
  assert.match(p, /sentinel/);
  assert.match(p, /files_examined/);
});

test("workerPrompt carries the task id so the result can be matched to its assignment", () => {
  const p = workerPrompt({
    task: { id: "t-abc", kind: "scan", angles: ["B"], focus: [], question: "q" },
    diff: DIFF, prepPack: {}, intentBrief: BRIEF,
  });
  assert.ok(p.includes("t-abc"));
});

test("testPlanPrompt tells Opus the floor and that opus is not an assignable model", () => {
  const p = testPlanPrompt({
    prepPack: {}, diff: DIFF, intentBrief: BRIEF, facts: [], gaps: [], round: 1, roundsLeft: 2,
  });
  assert.match(p, /A.*B.*C.*D.*E.*F.*G/s);
  assert.match(p, /haiku|sonnet/);
  assert.ok(!/"model"\s*:\s*"opus"/.test(p));
});

test("testPlanPrompt surfaces gaps from the previous round", () => {
  const p = testPlanPrompt({
    prepPack: {}, diff: DIFF, intentBrief: BRIEF, facts: [],
    gaps: ["C"], round: 2, roundsLeft: 1,
  });
  assert.match(p, /gap/i);
  assert.ok(p.includes("C"));
});

test("judgePrompt on the final round says so, and forbids requesting another", () => {
  const p = judgePrompt({ findings: [], evidence: [], gaps: [], round: 3, roundsLeft: 0, isFinalRound: true });
  assert.match(p, /final round/i);
  assert.match(p, /more_rounds_needed.*false|cannot request/i);
});

test("judgePrompt never asks for counts — code computes them", () => {
  const p = judgePrompt({ findings: [], evidence: [], gaps: [], round: 1, roundsLeft: 2, isFinalRound: false });
  assert.ok(!/emit.*counts|"counts"/i.test(p), "the judge must not author counts");
});

test("judgePrompt requires evidence on every refutation", () => {
  const p = judgePrompt({ findings: [], evidence: [], gaps: [], round: 1, roundsLeft: 2, isFinalRound: false });
  assert.match(p, /evidence_file/);
  assert.match(p, /evidence_line/);
});

test("judgePrompt carries the intent brief — the judge authors `intent`, no worker does", () => {
  const brief = {
    goal: "rate-limit the signup endpoint",
    acceptance_criteria: ["returns 429 on the 11th request in a minute"],
    in_scope: ["signup.js"],
    out_of_scope: ["login.js"],
  };
  const p = judgePrompt({
    findings: [], evidence: [], gaps: [], round: 1, roundsLeft: 2, isFinalRound: false,
    intentBrief: brief,
  });
  assert.ok(p.includes("rate-limit the signup endpoint"), "the brief's goal must reach the judge");
  assert.ok(p.includes("returns 429 on the 11th request in a minute"),
    "the acceptance criteria are the contract intent is ruled against");
  assert.ok(p.includes("out_of_scope") && p.includes("login.js"));
  assert.match(p, /aligned/);
  assert.match(p, /deviated/);
});

test("judgePrompt surfaces a SKIPPED brief as skipped rather than inviting a guess", () => {
  const p = judgePrompt({
    findings: [], evidence: [], gaps: [], round: 1, roundsLeft: 2, isFinalRound: false,
    intentBrief: { skipped: true },
  });
  assert.match(p, /skipped/i);
  assert.match(p, /intent.*"skipped"/,
    "an exempt diff must be reported as skipped, never inferred from the code");
});

test("workerPrompt gives the caller's test command ONLY to the test worker", () => {
  const args = {
    diff: DIFF, prepPack: {}, intentBrief: BRIEF,
    testCommand: "npm run test:ci", testHint: "install with pnpm first",
  };
  const testWorker = workerPrompt({
    task: { id: "x1", kind: "test", angles: [], focus: [], question: "q" }, ...args,
  });
  assert.ok(testWorker.includes("npm run test:ci"));
  assert.ok(testWorker.includes("install with pnpm first"));

  const scanWorker = workerPrompt({
    task: { id: "s1", kind: "scan", angles: ["B"], focus: [], question: "q" }, ...args,
  });
  assert.ok(!scanWorker.includes("npm run test:ci"),
    "a read-only worker cannot run anything; showing it a command invites a false claim");
});

test("the judge schema has no counts property", () => {
  assert.ok(!("counts" in SCHEMAS.judge.properties),
    "counts is written by the orchestrator from merge.js, never by the model");
});

test("the plan schema forbids opus at the schema level too", () => {
  const modelEnum = SCHEMAS.plan.properties.tasks.items.properties.model.enum;
  assert.deepEqual(modelEnum, ["haiku", "sonnet"]);
});

test("the worker schema requires the sentinel", () => {
  assert.ok(SCHEMAS.workerResult.required.includes("sentinel"));
  assert.ok(SCHEMAS.workerResult.required.includes("files_examined"));
});
