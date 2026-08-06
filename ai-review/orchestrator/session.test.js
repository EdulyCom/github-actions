"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRunner } = require("./session.js");
const { parseExecutionLog } = require("../lib/metrics.js");

/** A fake SDK query: yields the given messages, recording the options it got. */
const fakeQuery = (messages, spy) => (args) => {
  if (spy) spy.push(args);
  return (async function* () {
    for (const m of messages) yield m;
  })();
};

const okMessages = (data) => [
  { type: "system", subtype: "init", model: "claude-haiku-4-5" },
  { type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } },
  { type: "result", subtype: "success", is_error: false, num_turns: 3,
    total_cost_usd: 0.01, duration_ms: 1200, structured_output: data },
];

test("returns parsed structured output on success", async () => {
  const run = createRunner({ query: fakeQuery(okMessages({ hello: "world" })) });
  const res = await run({ prompt: "p", model: "haiku", schema: { type: "object" } });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.data, { hello: "world" });
});

test("captures a log that lib/metrics.js can parse unchanged", async () => {
  const run = createRunner({ query: fakeQuery(okMessages({ a: 1 })) });
  const res = await run({ prompt: "p", model: "haiku" });
  const parsed = parseExecutionLog(res.log);
  assert.equal(parsed.ran, true);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.turns, 3);
  assert.equal(parsed.numToolCalls, 1);
  assert.equal(parsed.model, "claude-haiku-4-5");
});

test("disables settings sources — the checkout is attacker-controlled", async () => {
  const spy = [];
  const run = createRunner({ query: fakeQuery(okMessages({}), spy) });
  await run({ prompt: "p", model: "haiku" });
  assert.deepEqual(spy[0].options.settingSources, [],
    "repo-local agent config must never load from a PR checkout");
});

test("passes the per-call model and tool allowlist through", async () => {
  const spy = [];
  const run = createRunner({ query: fakeQuery(okMessages({}), spy) });
  await run({ prompt: "p", model: "claude-sonnet-5", allowedTools: ["Read", "Grep"] });
  assert.equal(spy[0].options.model, "claude-sonnet-5");
  assert.deepEqual(spy[0].options.allowedTools, ["Read", "Grep"]);
});

test("defaults to an empty tool allowlist rather than inheriting anything", async () => {
  const spy = [];
  const run = createRunner({ query: fakeQuery(okMessages({}), spy) });
  await run({ prompt: "p", model: "haiku" });
  assert.deepEqual(spy[0].options.allowedTools, [],
    "with no schema there is nothing to allowlist");
});

// The Task 1 spike measured this: a schema-constrained session ends its turn by
// calling `StructuredOutput`. Allowlisting without it makes the session
// unterminable — it burns turns on other tools and dies at the cap. Every one
// of these three tests guards a call site the pipeline actually makes.
test("injects StructuredOutput whenever a schema is passed", async () => {
  const spy = [];
  const run = createRunner({ query: fakeQuery(okMessages({}), spy) });
  await run({ prompt: "p", model: "haiku", schema: { type: "object" } });
  assert.ok(spy[0].options.allowedTools.includes("StructuredOutput"));
});

test("injects StructuredOutput alongside an explicit read-only allowlist", async () => {
  const spy = [];
  const run = createRunner({ query: fakeQuery(okMessages({}), spy) });
  await run({ prompt: "p", model: "haiku", allowedTools: ["Read", "Grep"], schema: { type: "object" } });
  assert.deepEqual(spy[0].options.allowedTools, ["Read", "Grep", "StructuredOutput"]);
});

test("does not duplicate StructuredOutput if the caller already listed it", async () => {
  const spy = [];
  const run = createRunner({ query: fakeQuery(okMessages({}), spy) });
  await run({ prompt: "p", model: "haiku", allowedTools: ["StructuredOutput"], schema: { type: "object" } });
  assert.deepEqual(spy[0].options.allowedTools, ["StructuredOutput"]);
});

test("does not mutate the caller's allowlist array", async () => {
  const spy = [];
  const mine = ["Read"];
  const run = createRunner({ query: fakeQuery(okMessages({}), spy) });
  await run({ prompt: "p", model: "haiku", allowedTools: mine, schema: { type: "object" } });
  assert.deepEqual(mine, ["Read"], "READ_ONLY_TOOLS is a shared frozen constant");
});

test("a result with is_error true is not ok", async () => {
  const run = createRunner({
    query: fakeQuery([{ type: "result", subtype: "error_during_execution", is_error: true }]),
  });
  assert.equal((await run({ prompt: "p", model: "haiku" })).ok, false);
});

test("a stream that ends with no result at all is not ok", async () => {
  const run = createRunner({ query: fakeQuery([{ type: "system", subtype: "init" }]) });
  const res = await run({ prompt: "p", model: "haiku" });
  assert.equal(res.ok, false);
  assert.match(res.error, /no result/i);
});

test("a schema request that yields no structured output is not ok", async () => {
  const run = createRunner({
    query: fakeQuery([{ type: "result", subtype: "success", is_error: false }]),
  });
  const res = await run({ prompt: "p", model: "haiku", schema: { type: "object" } });
  assert.equal(res.ok, false);
  assert.match(res.error, /structured output/i);
});

test("a throwing query is caught, not propagated", async () => {
  const run = createRunner({
    query: () => (async function* () { throw new Error("subprocess died"); })(),
  });
  const res = await run({ prompt: "p", model: "haiku" });
  assert.equal(res.ok, false);
  assert.match(res.error, /subprocess died/);
});

test("a hung session is bounded by timeoutMs rather than running to the job kill", async () => {
  const run = createRunner({
    timeoutMs: 20,
    query: () => (async function* () {
      await new Promise((r) => setTimeout(r, 5000));
      yield { type: "result", is_error: false };
    })(),
  });
  const res = await run({ prompt: "p", model: "haiku" });
  assert.equal(res.ok, false);
  assert.match(res.error, /timed out/i);
});

test("aborts the underlying query when the timeout fires", async () => {
  let aborted = false;
  const run = createRunner({
    timeoutMs: 20,
    query: ({ options }) => {
      options.abortController.signal.addEventListener("abort", () => { aborted = true; });
      return (async function* () {
        await new Promise((r) => setTimeout(r, 5000));
        yield { type: "result", is_error: false };
      })();
    },
  });
  await run({ prompt: "p", model: "haiku" });
  assert.equal(aborted, true, "a timed-out session must not keep running in the background");
});

test("passes an AbortController to every query", async () => {
  const spy = [];
  const run = createRunner({ query: fakeQuery(okMessages({}), spy) });
  await run({ prompt: "p", model: "haiku" });
  assert.ok(spy[0].options.abortController instanceof AbortController);
});

test("the log returned on timeout cannot mutate afterwards", async () => {
  let push;
  const run = createRunner({
    timeoutMs: 20,
    query: () => (async function* () {
      await new Promise((r) => { push = r; });
      yield { type: "result", is_error: false, num_turns: 99 };
    })(),
  });
  const res = await run({ prompt: "p", model: "haiku" });
  const lengthAtReturn = res.log.length;
  if (push) push();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(res.log.length, lengthAtReturn,
    "a late result must not appear in a stage already recorded as timed out");
});

test("retry: true retries once and succeeds on the second attempt", async () => {
  let calls = 0;
  const run = createRunner({
    query: () => {
      calls += 1;
      return calls === 1
        ? (async function* () { throw new Error("flake"); })()
        : (async function* () { for (const m of okMessages({ ok: true })) yield m; })();
    },
  });
  const res = await run({ prompt: "p", model: "haiku", retry: true });
  assert.equal(res.ok, true);
  assert.equal(calls, 2, "exactly one retry, not a loop");
});

test("retry: true gives up after the single retry", async () => {
  let calls = 0;
  const run = createRunner({
    query: () => { calls += 1; return (async function* () { throw new Error("flake"); })(); },
  });
  const res = await run({ prompt: "p", model: "haiku", retry: true });
  assert.equal(res.ok, false);
  assert.equal(calls, 2);
});

test("retry is opt-in — a failing call without it runs exactly once", async () => {
  let calls = 0;
  const run = createRunner({
    query: () => { calls += 1; return (async function* () { throw new Error("flake"); })(); },
  });
  await run({ prompt: "p", model: "haiku" });
  assert.equal(calls, 1);
});
