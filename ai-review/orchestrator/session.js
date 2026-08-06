"use strict";

// The single chokepoint every model call passes through.
//
// Three responsibilities, each closing a specific defect:
//
//  1. ISOLATION. Workers run with cwd at the PR head, which is attacker-
//     controlled. Repo-local agent config can define hooks that execute shell
//     commands in a process holding the Anthropic key, and repo memory files
//     auto-load into the system prompt. `settingSources: []` is what stops
//     that. See spec section 5 and ADR 0001(d).
//
//  2. BOUNDS. Correct async-iterator consumption is exactly what upstream got
//     wrong twice (claude-code-action #1339, #1499) — that code is ours now.
//     A hung session with no timeout runs to the caller's 60-minute kill. A
//     timeout is NOT the banned --max-turns: nothing resumes a timed-out
//     session, so no half-finished analysis can be laundered into a verdict.
//
//  3. LOG CAPTURE. The raw message array is returned verbatim so
//     lib/metrics.js parseExecutionLog reads it unchanged and per-stage
//     telemetry keeps working across the rewrite.

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// The SDK completes a schema-constrained turn by calling this tool. Denying it
// makes the session unterminable. See the Task 1 spike finding in the spec.
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

/**
 * @param {{query: Function, timeoutMs?: number, maxTurns?: number, cwd?: string}} deps
 * @returns {(opts: object) => Promise<{ok: boolean, data: unknown, log: unknown[], error: string|null}>}
 */
function createRunner(deps) {
  const query = deps.query;
  const timeoutMs = Number(deps.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const defaultMaxTurns = Number(deps.maxTurns) || undefined;
  const cwd = deps.cwd;

  async function once({ prompt, model, allowedTools, schema, maxTurns }) {
    const log = [];
    let timer = null;

    // MEASURED, NOT ASSUMED (Task 1 spike): structured output completes the
    // turn by calling a tool named `StructuredOutput`. An allowlist that omits
    // it denies the model the only way to finish — the session burns turns on
    // unrelated tools and dies at the cap with no output. Injecting it here,
    // rather than in each caller's constant, makes it impossible to forget.
    const tools = Array.isArray(allowedTools) ? [...allowedTools] : [];
    if (schema && !tools.includes(STRUCTURED_OUTPUT_TOOL)) tools.push(STRUCTURED_OUTPUT_TOOL);

    const options = {
      model,
      cwd,
      settingSources: [],           // attacker-controlled checkout: load nothing from it
      includePartialMessages: false,
      allowedTools: tools,
      maxTurns: Number(maxTurns) || defaultMaxTurns,
    };
    if (schema) options.outputFormat = { type: "json_schema", schema };

    const run = (async () => {
      for await (const message of query({ prompt, options })) {
        log.push(message);
      }
      const result = [...log].reverse().find((m) => m && m.type === "result");
      if (!result) {
        return { ok: false, data: null, log, error: "session ended with no result message" };
      }
      if (result.is_error === true || result.subtype === "error_during_execution") {
        return { ok: false, data: null, log, error: `session reported ${result.subtype || "an error"}` };
      }
      const data = result.structured_output === undefined ? null : result.structured_output;
      if (schema && (data === null || data === undefined)) {
        return { ok: false, data: null, log, error: "session produced no structured output" };
      }
      return { ok: true, data, log, error: null };
    })();

    const guard = new Promise((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, data: null, log, error: `session timed out after ${timeoutMs}ms` }),
        timeoutMs
      );
    });

    try {
      return await Promise.race([run, guard]);
    } catch (err) {
      return { ok: false, data: null, log, error: String((err && err.message) || err) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return async function runSession(opts) {
    const first = await once(opts);
    if (first.ok || !opts.retry) return first;
    // Exactly one retry. The no-structured-output flake (ADR 0004) multiplies
    // across ~10-40 sessions per review; with no retry the inconclusive rate
    // blows past the <5% gate, and with a loop the round cap stops bounding.
    const second = await once(opts);
    return second.ok ? second : { ...second, error: `${first.error}; retry: ${second.error}` };
  };
}

module.exports = { createRunner, DEFAULT_TIMEOUT_MS, STRUCTURED_OUTPUT_TOOL };
