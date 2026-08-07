# ai-review PR-A: Instrumentation & Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land PR-A of the `ai-review` parallel-review migration — per-stage telemetry, a structural guard against dangling/duplicate step references, and a verbatim extraction of the Publish step's pure logic into `lib/publish.js` — with **zero behaviour change** to the verdict, labels, or job outputs.

**Architecture:** Two independent, already-proven pieces get re-landed from the reverted `feat/ai-review-telemetry` branch (`be2ab85`) verbatim: `lib/metrics.js` (structural, not grep-based, log parsing) and the glob-based `unit.yml` test discovery. One new piece — `lib/action-refs.js` — is a text-level guard against the exact class of bug ("dangling `steps.<id>.` reference", "duplicate `id:`") that nothing today catches short of a paid Opus run. The Publish step's ~340 lines of inline `github-script` get split: pure string/logic functions move to `lib/publish.js` (unit-testable without a live model run), the GitHub API calls that need the injected `github`/`context`/`core` objects stay in the YAML.

**Tech Stack:** Node.js `node:test` + `node:assert/strict` (built-in, no dependencies), GitHub Actions composite action YAML, `actions/github-script`.

## Global Constraints

- **Zero behaviour change.** Verdicts, labels, and the four job outputs (`verdict`/`confidence`/`merge_risk`/`review_event`) must be byte-identical to today's action on the same inputs. This is the PR-A gate from the design spec (`docs/superpowers/specs/2026-08-07-ai-review-parallel-review-design.md` §12): *"3 selftest runs, identical verdicts to pre-change, per-stage numbers visible in the summary."*
- **`ai-review/lib/recompute.js` and `recompute.test.js` are untouched.** Read-only to every task in this plan.
- **No new runtime dependencies.** `node:test`, `node:assert/strict`, `node:fs`, `node:path` only — matches the existing `recompute.js`/`recompute.test.js` pattern.
- **Third-party actions stay SHA-pinned** with a `# vX.Y.Z` comment (ADR 0001).
- **Every attacker-influenceable value reaches a shell only via step-level `env:`**, never inline `${{ }}` in `run:` (ADR 0001 (d)). This plan touches no attacker-influenceable input paths, but new `env:` blocks must follow the pattern.
- **Do not reformat the "Resolve linked issues" step** (`ai-review/action.yml:411-444`) — `.github/workflows/parity.yml` string-matches its GraphQL query and jq transform verbatim against `ai-qa/action.yml`. This plan does not touch that step, but any task that edits nearby lines must leave it byte-identical.
- **Frequent, small commits** — one commit per task below, in order.

---

### Task 1: Point `unit.yml` at every `lib/*.test.js` by glob

**Files:**
- Modify: `.github/workflows/unit.yml`

**Interfaces:**
- Consumes: nothing new.
- Produces: a test-discovery mechanism every later task in this plan relies on — a new `ai-review/lib/<name>.test.js` file is picked up automatically, no workflow edit needed.

This must land first: Tasks 2 and 3 both add new `*.test.js` files, and without this change they would silently never run in CI (the current workflow hardcodes the single path `ai-review/lib/recompute.test.js`).

- [ ] **Step 1: Apply the workflow edit**

Current content of `.github/workflows/unit.yml`:

```yaml
name: Unit tests

# The deterministic gate arithmetic in ai-review/lib/recompute.js is the one
# piece of this repo that can be tested without paying for a live model run.
# Issue #25 (a P2-only diff hard-failing the gate) shipped because that
# arithmetic lived inline in a github-script block with no test lane.

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  node-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - name: Run node:test
        shell: bash
        run: |
          set -euo pipefail
          node --version
          node --test ai-review/lib/recompute.test.js
```

Replace it with:

```yaml
name: Unit tests

# Everything under ai-review/lib/ is logic that can be tested without paying
# for a live model run — measured at 6-59 minutes and $1.74-$38.59 each.
# Issue #25 (a P2-only diff hard-failing the gate) shipped because the gate
# arithmetic lived inline in a github-script block with no test lane.
#
# Discovery is by directory, so adding a *.test.js file needs no edit here.

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  node-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - name: Run node:test
        shell: bash
        run: |
          set -euo pipefail
          node --version
          # Quoted so node expands the glob itself rather than the shell —
          # `node --test <dir>` does NOT scan a directory, it tries to load it
          # as a module entry point and fails with MODULE_NOT_FOUND.
          node --test "ai-review/lib/**/*.test.js"
```

- [ ] **Step 2: Verify the glob still finds the existing test file**

Run: `node --test "ai-review/lib/**/*.test.js"`
Expected: the 21 existing `recompute.test.js` tests run and pass (this is the only `*.test.js` file that exists at this point in the plan) — output ends with `pass 21` / `fail 0`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/unit.yml
git commit -m "ci(ai-review): discover unit tests by glob, not a hardcoded path

Every later PR-A task adds a new ai-review/lib/*.test.js file. Without
this, unit.yml's hardcoded single path would silently never run them.

node --test <dir> does not scan a directory — it tries to load it as a
module entry point and fails with MODULE_NOT_FOUND — so the glob must
be quoted and expanded by node itself, not the shell."
```

---

### Task 2: Re-land per-stage telemetry (`lib/metrics.js`)

**Files:**
- Create: `ai-review/lib/metrics.js`
- Create: `ai-review/lib/metrics.test.js`

**Interfaces:**
- Consumes: nothing (pure module — no `fs`, no `process.env`).
- Produces (used by Task 4's `action.yml` wiring):
  - `parseExecutionLog(entries: unknown) => {ran, ok, turns, costUsd, durationMs, model, numToolCalls, toolCalls}`
  - `collectMetrics(stages: {name: string, log: unknown}[]) => {stages: Record<string, ReturnType<typeof parseExecutionLog>>, totals: {turns, costUsd, durationMs, numToolCalls, dominantStage, dominantShare}}`
  - `renderSummary(metrics: ReturnType<typeof collectMetrics>) => string` (markdown for `$GITHUB_STEP_SUMMARY`)
  - `formatDuration(ms: number|null) => string`

This is a **verbatim re-land** of `ai-review/lib/metrics.js` / `metrics.test.js` from commit `be2ab85` (`feat(ai-review): per-stage turn, cost, and duration telemetry`), which was reverted along with the rest of `feat/ai-review-telemetry` for unrelated reasons (the orchestrator's own defects — see the design spec's risk register) but was itself already correct, already tested, and already proven: it fixed two real measurement bugs (a 22-entry `--allowedTools` allowlist echoed 3× in a log misread as "66 Bash tool calls"; a `head -1` conflating the Context stage's numbers with the Review stage's). Both are now regression tests. No new design work — copy the content below exactly.

- [ ] **Step 1: Create the test file**

Create `ai-review/lib/metrics.test.js`:

```javascript
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
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `node --test ai-review/lib/metrics.test.js`
Expected: FAIL — `Cannot find module './metrics.js'` (the implementation does not exist yet).

- [ ] **Step 3: Create the implementation file**

Create `ai-review/lib/metrics.js`:

```javascript
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
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `node --test ai-review/lib/metrics.test.js`
Expected: PASS — `pass 12`, `fail 0`.

- [ ] **Step 5: Run the full glob to confirm Task 1's discovery picks it up**

Run: `node --test "ai-review/lib/**/*.test.js"`
Expected: PASS — `pass 33` (21 from `recompute.test.js` + 12 from `metrics.test.js`), `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add ai-review/lib/metrics.js ai-review/lib/metrics.test.js
git commit -m "feat(ai-review): re-land per-stage turn, cost, and duration telemetry

Verbatim re-land of ai-review/lib/metrics.js + metrics.test.js from
be2ab85, which was reverted along with the rest of
feat/ai-review-telemetry for unrelated reasons (the orchestrator's own
defects, not this module). This module was already correct and already
tested — no new design work.

parseExecutionLog parses the log structurally rather than grepping it,
because both measurement errors made in the original archaeology dig
came from grepping: a 22-entry --allowedTools allowlist echoed 3x in
the inputs dump was read as '66 Bash tool calls', and head -1 over a
job log reported the Context stage's 36 turns / \$0.31 as the Review
stage's figures. Both failures are pinned by tests.

Not yet wired into action.yml — that is Task 4 of this plan."
```

---

### Task 3: Structural guard against dangling/duplicate step-id references (`lib/action-refs.js`)

**Files:**
- Create: `ai-review/lib/action-refs.js`
- Create: `ai-review/lib/action-refs.test.js`

**Interfaces:**
- Consumes: nothing (pure module — the integration tests in Step 6 below read `ai-review/action.yml` via `node:fs`, but that I/O lives in the test file, not in `action-refs.js` itself).
- Produces:
  - `extractDeclaredIds(yamlText: string) => string[]`
  - `extractReferencedIds(yamlText: string) => string[]` (deduped)
  - `findDuplicateIds(yamlText: string) => string[]`
  - `findDanglingRefs(yamlText: string) => string[]`

This is new: nothing today catches a duplicate `id:` or a `steps.<id>.` reference to a step that was renamed or deleted — YAML stays valid, and `actions/runner` only fails at run time, on the exact code path that hits the bad reference. The design spec's risk register (item 8 of the reverted-attempt defects) names exactly this class of bug. Verified against the real file before writing this task: every step in `ai-review/action.yml` declares its `id:` at exactly 6-space indentation directly under its `- name:` line, and no other `id:` occurrence in the file (JS object keys like `review_id:`, a GraphQL `$id: ID!` parameter, the `app-id:` input) appears at that indentation — so a text-level regex is precise here, with no need for a YAML-parsing dependency.

- [ ] **Step 1: Create the test file**

Create `ai-review/lib/action-refs.test.js`:

```javascript
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  extractDeclaredIds,
  extractReferencedIds,
  findDuplicateIds,
  findDanglingRefs,
} = require("./action-refs.js");

const FIXTURE_OK = `
runs:
  using: composite
  steps:
    - name: First
      id: first
      run: echo hi
    - name: Second
      id: second
      if: steps.first.outputs.x == 'y'
      run: echo \${{ steps.first.outputs.x }}
`;

const FIXTURE_DUPLICATE = `
runs:
  using: composite
  steps:
    - name: First
      id: dup
      run: echo hi
    - name: Second
      id: dup
      run: echo bye
`;

const FIXTURE_DANGLING = `
runs:
  using: composite
  steps:
    - name: Only
      id: only
      if: steps.ghost.outputs.x == 'y'
      run: echo hi
`;

const FIXTURE_HYPHEN_UNDERSCORE_IDS = `
runs:
  using: composite
  steps:
    - name: Fork guard
      id: fork-guard
      run: echo hi
    - name: Review retry
      id: review_retry
      if: steps.fork-guard.outputs.x == 'y' && steps.review_retry.outcome == 'z'
      run: echo bye
`;

// --- extractDeclaredIds -----------------------------------------------------

test("extractDeclaredIds finds every 6-space-indented id: line", () => {
  assert.deepEqual(extractDeclaredIds(FIXTURE_OK), ["first", "second"]);
});

test("extractDeclaredIds handles hyphens and underscores in ids", () => {
  assert.deepEqual(extractDeclaredIds(FIXTURE_HYPHEN_UNDERSCORE_IDS), [
    "fork-guard",
    "review_retry",
  ]);
});

// --- extractReferencedIds ---------------------------------------------------

test("extractReferencedIds finds steps.<id>. usages, deduped", () => {
  assert.deepEqual(extractReferencedIds(FIXTURE_OK), ["first"]);
});

test("extractReferencedIds matches steps.<id>.outcome as well as .outputs.", () => {
  const referenced = extractReferencedIds(FIXTURE_HYPHEN_UNDERSCORE_IDS);
  assert.ok(referenced.includes("fork-guard"));
  assert.ok(referenced.includes("review_retry"));
});

// --- findDuplicateIds --------------------------------------------------------

test("findDuplicateIds is empty on a clean fixture", () => {
  assert.deepEqual(findDuplicateIds(FIXTURE_OK), []);
});

test("findDuplicateIds catches a repeated id", () => {
  assert.deepEqual(findDuplicateIds(FIXTURE_DUPLICATE), ["dup"]);
});

// --- findDanglingRefs --------------------------------------------------------

test("findDanglingRefs is empty on a clean fixture", () => {
  assert.deepEqual(findDanglingRefs(FIXTURE_OK), []);
});

test("findDanglingRefs catches a reference to a step that was never declared", () => {
  assert.deepEqual(findDanglingRefs(FIXTURE_DANGLING), ["ghost"]);
});

// --- Integration: the real production file -----------------------------------

test("ai-review/action.yml has no duplicate step ids", () => {
  const yamlText = fs.readFileSync(
    path.join(__dirname, "..", "action.yml"),
    "utf8"
  );
  assert.deepEqual(findDuplicateIds(yamlText), []);
});

test("ai-review/action.yml has no dangling steps.<id>. references", () => {
  const yamlText = fs.readFileSync(
    path.join(__dirname, "..", "action.yml"),
    "utf8"
  );
  assert.deepEqual(findDanglingRefs(yamlText), []);
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `node --test ai-review/lib/action-refs.test.js`
Expected: FAIL — `Cannot find module './action-refs.js'`.

- [ ] **Step 3: Create the implementation file**

Create `ai-review/lib/action-refs.js`:

```javascript
"use strict";

// Structural guards for ai-review/action.yml's composite-action step graph.
// Nothing else catches a duplicate `id:` or a `steps.<id>.` reference to a
// step that doesn't exist — YAML is still valid, actions/runner only fails
// at run time (and only on the exact code path that hits the bad reference),
// so a typo here has shipped to production before. Pure text-level checks:
// this repo takes no YAML-parsing dependency, and the file's step shape
// (4-space `- name:`, 6-space sub-keys) is consistent enough that a couple
// of regexes cover it without one.

const ID_DECL_RE = /^ {6}id: (\S+)\s*$/gm;
const STEP_REF_RE = /steps\.([\w-]+)\./g;

function extractDeclaredIds(yamlText) {
  const ids = [];
  for (const m of yamlText.matchAll(ID_DECL_RE)) ids.push(m[1]);
  return ids;
}

function extractReferencedIds(yamlText) {
  const ids = new Set();
  for (const m of yamlText.matchAll(STEP_REF_RE)) ids.add(m[1]);
  return [...ids];
}

function findDuplicateIds(yamlText) {
  const seen = new Set();
  const dupes = new Set();
  for (const id of extractDeclaredIds(yamlText)) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

function findDanglingRefs(yamlText) {
  const declared = new Set(extractDeclaredIds(yamlText));
  return extractReferencedIds(yamlText).filter((id) => !declared.has(id));
}

module.exports = {
  extractDeclaredIds,
  extractReferencedIds,
  findDuplicateIds,
  findDanglingRefs,
};
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `node --test ai-review/lib/action-refs.test.js`
Expected: PASS — `pass 9`, `fail 0`. The last two tests (the integration checks against the real `ai-review/action.yml`) must pass on the file as it exists today, before any later task in this plan edits it — this proves the guard has no false positives against the current production file.

- [ ] **Step 5: Run the full glob**

Run: `node --test "ai-review/lib/**/*.test.js"`
Expected: PASS — `pass 42` (21 + 12 + 9), `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add ai-review/lib/action-refs.js ai-review/lib/action-refs.test.js
git commit -m "test(ai-review): guard against dangling or duplicate step-id references

Nothing today catches a duplicate id: or a steps.<id>. reference to a
step that was renamed or deleted -- YAML stays syntactically valid, and
actions/runner only fails at run time, on the exact code path that hits
the bad reference. The reverted feat/ai-review-telemetry attempt's own
risk register names exactly this class of bug (defect 8: a README that
outlived the pipeline it described, caught by nothing until reviewed by
hand).

Two tests run against the real production action.yml, not just fixtures,
so this is a live regression guard from the moment it lands -- both pass
against the file as it exists today, before this plan's later tasks
touch it."
```

---

### Task 4: Wire telemetry into `action.yml` (3 snapshot steps + 1 telemetry step)

**Files:**
- Modify: `ai-review/action.yml`

**Interfaces:**
- Consumes: `lib/metrics.js`'s `collectMetrics`/`renderSummary` from Task 2.
- Produces: nothing new for later tasks — this is the terminal wiring for telemetry.

`claude-code-action` writes every stage's execution log to one fixed path (`${RUNNER_TEMP}/claude-execution-output.json`), so each subsequent invocation overwrites the previous stage's log. The Review stage's own snapshot step (`Snapshot the review stage's execution log`, current lines 696-706) already exists in `action.yml` and handles this for the Review stage. Two more snapshots are needed — Context and Repair — plus the telemetry step itself that reads all four snapshots/outputs and renders the summary. All four insertions are `continue-on-error`/`if: always()` observation steps: **none can fail the job, and none can change `verdict`/`confidence`/`merge_risk`/`review_event`.**

- [ ] **Step 1: Insert the Context-stage snapshot step**

In `ai-review/action.yml`, find this exact text (the end of the Context stage step, immediately before the `Verify context.md handoff` step):

```
          Do NOT review the change. Do NOT judge correctness, quality, or security.
          Do NOT produce a verdict, opinion, or recommendation of any kind. Your only
          output is the factual context.md summary — a later stage does the review.

    - name: Verify context.md handoff
```

Replace it with:

```
          Do NOT review the change. Do NOT judge correctness, quality, or security.
          Do NOT produce a verdict, opinion, or recommendation of any kind. Your only
          output is the factual context.md summary — a later stage does the review.

    # Same shared-path problem the review snapshot below documents: every
    # claude-code-action step writes its execution log to the one fixed path
    # "${RUNNER_TEMP}/claude-execution-output.json", so the Review stage
    # destroys the Context stage's log before the telemetry step can read it.
    # Snapshot it now, while it is still context's own output. Observation
    # only — never fails the job, never affects the verdict.
    - name: Snapshot the context stage's execution log
      if: always() && steps.fork-guard.outputs.is-fork != 'true' && steps.pr-state.outputs.skip != 'true'
      shell: bash
      env:
        EXEC_FILE: ${{ steps.context.outputs.execution_file }}
      run: |
        set -uo pipefail
        if [ -n "${EXEC_FILE:-}" ] && [ -s "${EXEC_FILE}" ]; then
          cp "${EXEC_FILE}" "${RUNNER_TEMP}/ai-review-exec-context-snapshot.json" || true
        fi
        exit 0

    - name: Verify context.md handoff
```

- [ ] **Step 2: Insert the Repair-stage snapshot step**

Find this exact text (the end of the `Review stage — structured-output repair` step, immediately before the back-off comment block):

```
          Emitting the structured output is your only remaining task.

    # The full retry previously fired ~11s after the first attempt ended and
```

Replace it with:

```
          Emitting the structured output is your only remaining task.

    # Snapshot for the same shared-path reason as the two above. Repair's log
    # only survives at the shared path when the retry does NOT run; on the
    # double-failure path the retry overwrites it, and its cost would silently
    # vanish from the telemetry totals. Observation only.
    - name: Snapshot the repair stage's execution log
      if: always() && steps.fork-guard.outputs.is-fork != 'true' && steps.pr-state.outputs.skip != 'true'
      shell: bash
      env:
        EXEC_FILE: ${{ steps.review_repair.outputs.execution_file }}
      run: |
        set -uo pipefail
        if [ -n "${EXEC_FILE:-}" ] && [ -s "${EXEC_FILE}" ]; then
          cp "${EXEC_FILE}" "${RUNNER_TEMP}/ai-review-exec-repair-snapshot.json" || true
        fi
        exit 0

    # The full retry previously fired ~11s after the first attempt ended and
```

- [ ] **Step 3: Append the telemetry step at the very end of the file**

Find the last four lines of `ai-review/action.yml`:

```
          core.setOutput("verdict", verdict);
          core.setOutput("confidence", String(confidence));
          core.setOutput("merge_risk", mergeRisk);
          core.setOutput("review_event", reviewEvent);
```

Replace with those same four lines plus the new step appended after:

```
          core.setOutput("verdict", verdict);
          core.setOutput("confidence", String(confidence));
          core.setOutput("merge_risk", mergeRisk);
          core.setOutput("review_event", reviewEvent);

    # Per-stage turns / cost / duration, rendered to the job summary. Pure
    # observation: runs after the verdict is published, never fails the job,
    # and touches nothing the gate depends on.
    #
    # Why this exists: the Review stage was measured at 56m04s of a 59m job
    # (138 turns, $31.01) while the repair/retry/salvage chain contributed
    # zero — but that took an archaeology dig through raw runner logs to
    # establish, and two of the numbers derived that way were wrong. This
    # step is where every later phase gate in the parallel-review migration
    # gets its numbers from.
    - name: Pipeline telemetry
      id: telemetry
      if: always() && steps.fork-guard.outputs.is-fork != 'true' && steps.pr-state.outputs.skip != 'true'
      continue-on-error: true
      uses: actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd # v8.0.0
      env:
        METRICS_PATH: ${{ github.action_path }}/lib/metrics.js
        # Snapshots, not the live outputs: claude-code-action writes every
        # stage's log to the same fixed path, so only the last one survives.
        CONTEXT_LOG: ${{ runner.temp }}/ai-review-exec-context-snapshot.json
        REVIEW_LOG: ${{ runner.temp }}/ai-review-exec-review-snapshot.json
        REPAIR_LOG: ${{ runner.temp }}/ai-review-exec-repair-snapshot.json
        RETRY_LOG: ${{ steps.review_retry.outputs.execution_file }}
      with:
        script: |
          const fs = require("fs");
          const { collectMetrics, renderSummary } = require(process.env.METRICS_PATH);

          const read = (p) => {
            try {
              return JSON.parse(fs.readFileSync(p, "utf8"));
            } catch {
              return null; // absent (stage skipped) or unreadable — both are "not run"
            }
          };

          const metrics = collectMetrics([
            { name: "context", log: read(process.env.CONTEXT_LOG) },
            { name: "review", log: read(process.env.REVIEW_LOG) },
            { name: "review_repair", log: read(process.env.REPAIR_LOG) },
            { name: "review_retry", log: read(process.env.RETRY_LOG) },
          ]);

          await core.summary.addRaw(renderSummary(metrics)).write();

          // Also in the plain log, so a run's numbers survive summary retention
          // and can be scraped for the baseline table.
          core.info(`ai-review-metrics ${JSON.stringify(metrics.totals)}`);
```

- [ ] **Step 4: Verify YAML is still syntactically valid**

Run: `python3 -c "import yaml; yaml.safe_load(open('ai-review/action.yml')); print('valid')"`
Expected: `valid` — no exception. (This repo has no local `actionlint`; `.github/workflows/actionlint.yml` and `zizmor.yml` re-check on push, but a syntax error should be caught here first.)

- [ ] **Step 5: Verify the structural guard from Task 3 still passes against the now-modified file**

Run: `node --test ai-review/lib/action-refs.test.js`
Expected: PASS. All new `steps.<id>.` references added in this task (`steps.context.outputs.execution_file`, `steps.review_repair.outputs.execution_file`, `steps.review_retry.outputs.execution_file`) point at ids already declared before this task ran — no new ids were introduced (the snapshot steps deliberately have no `id:`, matching the existing review-snapshot step's pattern, since nothing needs to reference them by id).

- [ ] **Step 6: Confirm zero behaviour change by inspection**

Run: `git diff ai-review/action.yml`
Expected: only additive hunks (4 new step blocks). No existing `if:`, `env:`, `with:`, or `run:` line for any pre-existing step is modified. If the diff shows anything beyond pure insertion, stop and re-check Steps 1-3 above — this task must not touch gate logic.

- [ ] **Step 7: Commit**

```bash
git add ai-review/action.yml
git commit -m "feat(ai-review): wire per-stage telemetry into the pipeline

Adds three steps, all if: always() / continue-on-error, none able to
affect verdict/confidence/merge_risk/review_event:

- Snapshot the context stage's execution log (new)
- Snapshot the repair stage's execution log (new)
- Pipeline telemetry (new) -- reads all four stage logs via lib/metrics.js
  and renders a per-stage turns/cost/duration table to the job summary

claude-code-action writes every stage's log to one fixed path, so each
invocation overwrites the last stage's log. The Review stage already had
its own snapshot step; Context and Repair did not, so their cost would
have silently vanished from the totals whenever the retry chain fired.

Zero behaviour change: verified by inspecting the diff (additive only)
and by the action-refs guard passing against the modified file."
```

---

### Task 5: Extract Publish's pure logic into `lib/publish.js`

**Files:**
- Create: `ai-review/lib/publish.js`
- Create: `ai-review/lib/publish.test.js`

**Interfaces:**
- Consumes: nothing (pure module — no `fs`, no `process.env`, no `github`/`context`/`core`).
- Produces (used by Task 6's `action.yml` wiring):
  - `stripLeadingBannerArtifacts(markdown: string) => string`
  - `buildReviewBody({verdict, confidence, mergeRisk, counts, intentDeviated, modelVerdict, blockers, commentBody}) => string`
  - `buildInconclusiveBody(salvaged: string) => string`
  - `tickVerifiedBoxes(originalBody: string, checklist: {text, status, evidence?}[]) => {newBody: string, ticks: number}`
  - `buildStatusBlock({checklist, verificationEvidence, verdict}) => string`
  - `upsertStatusBlock(body: string, block: string) => string`

The current `Publish review` step (`ai-review/action.yml`, currently lines 988-1332) is ~340 lines of inline `github-script`, none of it unit-tested — every prior fix to it (the over-tick collision guard, the never-untick rule, the `pulls.get` re-fetch race guard) was verified only by a live model run. This task moves every **pure** function — string construction and array/object logic with no GitHub API call — into `lib/publish.js`, verbatim from the current step, so it gets the same test coverage `recompute.js` already has. The GitHub API calls (`pulls.createReview`, `issues.addLabels`, `issues.removeLabel`, `pulls.get`, `pulls.update`) stay inline in the YAML in Task 6, because they need the `github`/`context` objects `actions/github-script` injects at runtime — those cannot be unit-tested without a live API, and this task does not attempt to.

- [ ] **Step 1: Create the test file**

Create `ai-review/lib/publish.test.js`:

```javascript
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  stripLeadingBannerArtifacts,
  buildReviewBody,
  buildInconclusiveBody,
  tickVerifiedBoxes,
  buildStatusBlock,
  upsertStatusBlock,
} = require("./publish.js");

// --- stripLeadingBannerArtifacts --------------------------------------------

test("strips a leading verdict token line", () => {
  const out = stripLeadingBannerArtifacts("**✅ PASS**\n\nReal content here.");
  assert.equal(out, "Real content here.");
});

test("strips a leading confidence/merge-risk line", () => {
  const out = stripLeadingBannerArtifacts(
    "Confidence: 90 · Merge risk: low\nReal content here."
  );
  assert.equal(out, "Real content here.");
});

test("strips a leading HTML comment", () => {
  const out = stripLeadingBannerArtifacts("<!-- ai-review -->\nReal content here.");
  assert.equal(out, "Real content here.");
});

test("strips multiple leading artifacts and blank lines together", () => {
  const out = stripLeadingBannerArtifacts(
    "<!-- ai-review -->\n**❌ FAIL**\n\nConfidence: 40 · Merge risk: high\n\nReal content here."
  );
  assert.equal(out, "Real content here.");
});

test("leaves real content with no leading artifacts untouched", () => {
  const out = stripLeadingBannerArtifacts("### P0 — Blockers\n\n_None._");
  assert.equal(out, "### P0 — Blockers\n\n_None._");
});

test("returns falsy input as-is", () => {
  assert.equal(stripLeadingBannerArtifacts(""), "");
  assert.equal(stripLeadingBannerArtifacts(null), null);
  assert.equal(stripLeadingBannerArtifacts(undefined), undefined);
});

// --- buildReviewBody ---------------------------------------------------------

const BASE_ARGS = {
  verdict: "pass",
  confidence: 95,
  mergeRisk: "low",
  counts: { p0: 0, p1: 0, p2: 0, p3: 0 },
  intentDeviated: false,
  modelVerdict: "pass",
  blockers: [],
  commentBody: "### Strengths\n\nClean diff.",
};

test("pass verdict with no P2/P3 has no advisory note and no rejected banner", () => {
  const body = buildReviewBody(BASE_ARGS);
  assert.match(body, /\*\*✅ PASS\*\*/);
  assert.doesNotMatch(body, /non-blocking/);
  assert.doesNotMatch(body, /Rejected/);
});

test("pass verdict with P2/P3 findings includes the advisory note", () => {
  const body = buildReviewBody({
    ...BASE_ARGS,
    counts: { p0: 0, p1: 0, p2: 2, p3: 1 },
  });
  assert.match(body, /2 P2 \/ 1 P3 finding\(s\) noted — non-blocking\./);
});

test("fail verdict with blockers includes the reason note", () => {
  const body = buildReviewBody({
    ...BASE_ARGS,
    verdict: "fail",
    modelVerdict: "fail",
    blockers: ["1 P0 blocker", "2 P1 findings"],
  });
  assert.match(body, /\*\*❌ FAIL\*\*/);
  assert.match(body, /Why the gate failed:\*\* 1 P0 blocker; 2 P1 findings\./);
});

test("intentDeviated adds the rejected banner ahead of the verdict line", () => {
  const body = buildReviewBody({ ...BASE_ARGS, intentDeviated: true });
  assert.match(body, /❌ \*\*Rejected — wrong solution\*\*\n\n\*\*✅ PASS\*\*/);
});

test("a model/deterministic verdict mismatch is noted", () => {
  const body = buildReviewBody({
    ...BASE_ARGS,
    verdict: "fail",
    modelVerdict: "pass",
    blockers: ["1 P1 finding"],
  });
  assert.match(
    body,
    /Deterministic recomputation \(\*\*fail\*\*\) overrides the model's self-reported verdict \(\*\*pass\*\*\)\./
  );
});

test("no mismatch note when the model verdict agrees", () => {
  const body = buildReviewBody(BASE_ARGS);
  assert.doesNotMatch(body, /overrides the model's self-reported verdict/);
});

test("an empty comment body falls back to a placeholder", () => {
  const body = buildReviewBody({ ...BASE_ARGS, commentBody: "" });
  assert.match(body, /_No review content returned\._/);
});

test("always leads with the <!-- ai-review --> marker", () => {
  const body = buildReviewBody(BASE_ARGS);
  assert.match(body, /^<!-- ai-review -->\n/);
});

// --- buildInconclusiveBody ---------------------------------------------------

test("without salvaged text there is no details block", () => {
  const body = buildInconclusiveBody("");
  assert.match(body, /inconclusive \(re-run required\)/);
  assert.doesNotMatch(body, /<details>/);
});

test("with salvaged text the details block contains it", () => {
  const body = buildInconclusiveBody("The diff looked fine but I ran out of turns.");
  assert.match(body, /<details><summary>Unstructured model output recovered/);
  assert.match(body, /The diff looked fine but I ran out of turns\./);
  assert.match(body, /<\/details>/);
});

// --- tickVerifiedBoxes --------------------------------------------------------

test("ticks a single matching unchecked box", () => {
  const { newBody, ticks } = tickVerifiedBoxes(
    "- [ ] Handles empty input\n- [ ] Logs errors",
    [{ text: "Handles empty input", status: "verified" }]
  );
  assert.equal(newBody, "- [x] Handles empty input\n- [ ] Logs errors");
  assert.equal(ticks, 1);
});

test("does not tick a box for a failed or unverifiable item", () => {
  const { newBody, ticks } = tickVerifiedBoxes("- [ ] Handles empty input", [
    { text: "Handles empty input", status: "failed" },
  ]);
  assert.equal(newBody, "- [ ] Handles empty input");
  assert.equal(ticks, 0);
});

test("never unticks an already-checked box", () => {
  // The checkbox regex only matches "[ ]" — an already-ticked "[x]" line is
  // never touched, regardless of what the checklist says about it.
  const { newBody, ticks } = tickVerifiedBoxes("- [x] Handles empty input", [
    { text: "Handles empty input", status: "failed" },
  ]);
  assert.equal(newBody, "- [x] Handles empty input");
  assert.equal(ticks, 0);
});

test("over-tick collision: ticks at most as many boxes as verified items with that text", () => {
  const { newBody, ticks } = tickVerifiedBoxes(
    "- [ ] Handles empty input\n- [ ] Handles empty input\n- [ ] Handles empty input",
    [{ text: "Handles empty input", status: "verified" }]
  );
  assert.equal(
    newBody,
    "- [x] Handles empty input\n- [ ] Handles empty input\n- [ ] Handles empty input"
  );
  assert.equal(ticks, 1);
});

test("normalizes markdown formatting differences between checklist and PR body text", () => {
  const { newBody, ticks } = tickVerifiedBoxes("- [ ] **Handles** `empty` input.", [
    { text: "Handles empty input", status: "verified" },
  ]);
  assert.equal(newBody, "- [x] **Handles** `empty` input.");
  assert.equal(ticks, 1);
});

test("zero ticks when nothing in the checklist is verified", () => {
  const { newBody, ticks } = tickVerifiedBoxes("- [ ] Handles empty input", []);
  assert.equal(newBody, "- [ ] Handles empty input");
  assert.equal(ticks, 0);
});

// --- buildStatusBlock ---------------------------------------------------------

test("renders the correct icon per checklist status", () => {
  const block = buildStatusBlock({
    checklist: [
      { text: "A", status: "verified" },
      { text: "B", status: "failed" },
      { text: "C", status: "unverifiable" },
    ],
    verificationEvidence: [],
    verdict: "pass",
  });
  assert.match(block, /✅ A/);
  assert.match(block, /❌ B/);
  assert.match(block, /❔ C/);
});

test("includes an item's evidence only when present", () => {
  const block = buildStatusBlock({
    checklist: [
      { text: "A", status: "verified", evidence: "ran the test suite" },
      { text: "B", status: "verified" },
    ],
    verificationEvidence: [],
    verdict: "pass",
  });
  assert.match(block, /✅ A — ran the test suite/);
  assert.match(block, /✅ B\n/);
});

test("includes the verification-evidence section only when there is evidence", () => {
  const withEvidence = buildStatusBlock({
    checklist: [{ text: "A", status: "verified" }],
    verificationEvidence: [{ command: "npm test", result: "0 failures" }],
    verdict: "pass",
  });
  assert.match(withEvidence, /_Verification evidence:_/);
  assert.match(withEvidence, /`npm test` → 0 failures/);

  const withoutEvidence = buildStatusBlock({
    checklist: [{ text: "A", status: "verified" }],
    verificationEvidence: [],
    verdict: "pass",
  });
  assert.doesNotMatch(withoutEvidence, /_Verification evidence:_/);
});

test("closing line names the verdict", () => {
  const block = buildStatusBlock({
    checklist: [{ text: "A", status: "verified" }],
    verificationEvidence: [],
    verdict: "fail",
  });
  assert.match(block, /_Last updated by ai-review · verdict: fail\._/);
});

// --- upsertStatusBlock ---------------------------------------------------------

test("replaces an existing status block in place", () => {
  const body = [
    "Some PR description.",
    "",
    "<!-- ai-review-status -->",
    "old content",
    "<!-- /ai-review-status -->",
    "",
    "Trailing text.",
  ].join("\n");
  const newBody = upsertStatusBlock(body, "<!-- ai-review-status -->\nnew content\n<!-- /ai-review-status -->");
  assert.match(newBody, /new content/);
  assert.doesNotMatch(newBody, /old content/);
  assert.match(newBody, /Trailing text\./);
});

test("appends a new status block when none exists, trimming trailing whitespace first", () => {
  const body = "Some PR description.\n\n\n";
  const newBody = upsertStatusBlock(body, "<!-- ai-review-status -->\ncontent\n<!-- /ai-review-status -->");
  assert.equal(
    newBody,
    "Some PR description.\n\n<!-- ai-review-status -->\ncontent\n<!-- /ai-review-status -->\n"
  );
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `node --test ai-review/lib/publish.test.js`
Expected: FAIL — `Cannot find module './publish.js'`.

- [ ] **Step 3: Create the implementation file**

Create `ai-review/lib/publish.js`. Every function below is copied **verbatim** from the current `Publish review` step (`ai-review/action.yml`, currently lines 1006-1327) — only the surrounding wiring (parameter names replacing closure captures) changes, never the logic itself:

```javascript
"use strict";

// Pure logic extracted from the Publish step's inline github-script body.
// Everything here is string/array construction with no GitHub API call, so
// it can be tested without a live model run or a live repo -- unlike the
// ~340-line step it came from, whose every prior fix (the over-tick
// collision guard, the never-untick rule) was verified only by hand against
// a real PR. The GitHub API calls (pulls.createReview, issues.addLabels,
// pulls.get, pulls.update) stay inline in action.yml: they need the
// `github`/`context` objects actions/github-script injects at runtime, and
// this module intentionally has zero I/O.

const STATUS_BLOCK_START = "<!-- ai-review-status -->";
const STATUS_BLOCK_END = "<!-- /ai-review-status -->";

// The review-stage prompt instructs the model not to prepend its own
// verdict token / confidence-merge-risk line / HTML marker to
// comment_markdown (the caller owns that banner), but model
// instruction-following is not guaranteed — strip any leading copy of
// those artifacts defensively so a non-compliant response can't
// duplicate the banner above it.
function stripLeadingBannerArtifacts(markdown) {
  if (!markdown) return markdown;
  const verdictTokenRe = /^\*\*(?:✅ PASS|❌ FAIL)\*\*\s*$/;
  const confidenceLineRe = /^Confidence:\s*\d+\s*·\s*Merge risk:\s*\S+\s*$/i;
  const htmlCommentRe = /^<!--.*-->\s*$/;
  const lines = markdown.split("\n");
  let start = 0;
  while (start < lines.length) {
    const line = lines[start];
    if (
      line.trim() === "" ||
      verdictTokenRe.test(line) ||
      confidenceLineRe.test(line) ||
      htmlCommentRe.test(line)
    ) {
      start += 1;
      continue;
    }
    break;
  }
  return lines.slice(start).join("\n");
}

/**
 * @param {{verdict: string, confidence: number, mergeRisk: string,
 *   counts: {p0:number,p1:number,p2:number,p3:number}, intentDeviated: boolean,
 *   modelVerdict: string|undefined, blockers: string[], commentBody: string}} args
 *   `commentBody` must already be run through stripLeadingBannerArtifacts.
 */
function buildReviewBody({
  verdict,
  confidence,
  mergeRisk,
  counts,
  intentDeviated,
  modelVerdict,
  blockers,
  commentBody,
}) {
  const verdictLine = verdict === "pass" ? "**✅ PASS**" : "**❌ FAIL**";
  const rejectedBanner = intentDeviated ? "❌ **Rejected — wrong solution**\n\n" : "";

  // State the machine reason for every fail. Without this, a
  // deterministic override reads as unexplained and gets attributed to
  // whatever the model happened to write about in comment_markdown —
  // exactly how issue #25 came to be filed as a test-toolchain bug.
  const reasonNote =
    verdict === "fail" && blockers.length
      ? `\n> **Why the gate failed:** ${blockers.join("; ")}.\n`
      : "";

  const mismatchNote =
    modelVerdict && modelVerdict !== verdict
      ? `\n> ⚠️ Deterministic recomputation (**${verdict}**) overrides the model's self-reported verdict (**${modelVerdict}**).\n`
      : "";

  // P2/P3 are advisory and never block (rubric.md §Severity). Say so
  // on a pass, so a reader does not wonder why nits were tolerated.
  const advisoryNote =
    verdict === "pass" && counts.p2 + counts.p3 > 0
      ? `\n> ${counts.p2} P2 / ${counts.p3} P3 finding(s) noted — non-blocking.\n`
      : "";

  return [
    "<!-- ai-review -->",
    `${rejectedBanner}${verdictLine}`,
    ...(mismatchNote ? [mismatchNote] : []),
    ...(reasonNote ? [reasonNote] : []),
    ...(advisoryNote ? [advisoryNote] : []),
    "",
    `Confidence: ${confidence} · Merge risk: ${mergeRisk}`,
    `P0: ${counts.p0} · P1: ${counts.p1} · P2: ${counts.p2} · P3: ${counts.p3}`,
    "",
    commentBody || "_No review content returned._",
  ].join("\n");
}

/** @param {string} salvaged possibly-empty text recovered from a missed structured output. */
function buildInconclusiveBody(salvaged) {
  return [
    "<!-- ai-review -->",
    "### ⚠️ AI Review — inconclusive (re-run required)",
    "",
    "The review model did not return a structured result after a",
    "resume-repair attempt and a full retry (a known intermittent",
    "`anthropics/claude-code-action` issue). This is **not** a",
    "code-quality judgment — the review did not complete, so the gate",
    "fails closed.",
    "",
    "**Re-run the `ai-review` job** to get a verdict.",
    ...(salvaged
      ? [
          "",
          "<details><summary>Unstructured model output recovered from the run (not a verdict)</summary>",
          "",
          salvaged,
          "",
          "</details>",
        ]
      : []),
  ].join("\n");
}

/**
 * Ticks unchecked PR-body checkboxes whose text matches a VERIFIED checklist
 * item. Never unchecks a human-checked box (the regex only matches "[ ]").
 * @param {string} originalBody
 * @param {{text: string, status: string, evidence?: string}[]} checklist
 * @returns {{newBody: string, ticks: number}}
 */
function tickVerifiedBoxes(originalBody, checklist) {
  const norm = (s) =>
    (s || "")
      .toLowerCase()
      .replace(/[`*_~]/g, "")
      .replace(/\s+/g, " ")
      .replace(/[.:;,\s]+$/, "")
      .trim();

  // Count verified items per normalized text, so we tick AT MOST as
  // many boxes as there were verified items with that text. This
  // stops one verified item from ticking several distinct boxes that
  // happen to normalize identically (over-tick collision).
  const verifiedCounts = new Map();
  for (const i of checklist) {
    if (i && i.status === "verified" && i.text) {
      const k = norm(i.text);
      verifiedCounts.set(k, (verifiedCounts.get(k) || 0) + 1);
    }
  }

  const checkboxRe = /^(\s*[-*]\s*)\[ \](\s*)(.+)$/;
  let ticks = 0;
  const newBody = originalBody
    .split("\n")
    .map((line) => {
      const m = line.match(checkboxRe);
      if (m) {
        const k = norm(m[3]);
        const remaining = verifiedCounts.get(k) || 0;
        if (remaining > 0) {
          verifiedCounts.set(k, remaining - 1);
          ticks += 1;
          return `${m[1]}[x]${m[2]}${m[3]}`;
        }
      }
      return line;
    })
    .join("\n");

  return { newBody, ticks };
}

/**
 * @param {{checklist: {text:string,status:string,evidence?:string}[],
 *   verificationEvidence: {command:string,result?:string}[], verdict: string}} args
 */
function buildStatusBlock({ checklist, verificationEvidence, verdict }) {
  const icon = (s) => (s === "verified" ? "✅" : s === "failed" ? "❌" : "❔");
  const itemLines = checklist
    .filter((i) => i && i.text)
    .map(
      (i) => `- ${icon(i.status)} ${i.text}${i.evidence ? ` — ${i.evidence}` : ""}`
    );
  const evLines = verificationEvidence
    .filter((e) => e && e.command)
    .map((e) => `- \`${e.command}\`${e.result ? ` → ${e.result}` : ""}`);

  const blockParts = [STATUS_BLOCK_START, "#### 🤖 AI Review — checklist verification", ...itemLines];
  if (evLines.length) {
    blockParts.push("", "_Verification evidence:_", ...evLines);
  }
  blockParts.push("", `_Last updated by ai-review · verdict: ${verdict}._`, STATUS_BLOCK_END);
  return blockParts.join("\n");
}

/** Replaces an existing managed status block in place, or appends a new one. */
function upsertStatusBlock(body, block) {
  const blockRe = new RegExp(`${STATUS_BLOCK_START}[\\s\\S]*?${STATUS_BLOCK_END}`);
  if (blockRe.test(body)) {
    return body.replace(blockRe, block);
  }
  return `${body.replace(/\s*$/, "")}\n\n${block}\n`;
}

module.exports = {
  stripLeadingBannerArtifacts,
  buildReviewBody,
  buildInconclusiveBody,
  tickVerifiedBoxes,
  buildStatusBlock,
  upsertStatusBlock,
};
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `node --test ai-review/lib/publish.test.js`
Expected: PASS — `pass 22`, `fail 0`.

- [ ] **Step 5: Run the full glob**

Run: `node --test "ai-review/lib/**/*.test.js"`
Expected: PASS — `pass 64` (21 + 12 + 9 + 22), `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add ai-review/lib/publish.js ai-review/lib/publish.test.js
git commit -m "test(ai-review): extract Publish's pure logic into lib/publish.js

The ~340-line inline Publish step has never had unit test coverage --
every prior fix to it (the over-tick collision guard, the never-untick
rule, the pulls.get re-fetch race guard) was verified only by a live
model run against a real PR. This moves every pure function -- string
construction and array/object logic with no GitHub API call -- into
lib/publish.js, verbatim from the current step, alongside the same test
coverage recompute.js already has.

The GitHub API calls (createReview, addLabels, removeLabel, pulls.get,
pulls.update) stay inline in action.yml -- they need the github/context
objects actions/github-script injects at runtime and cannot be unit
tested without a live API. Not yet wired into action.yml; that is
Task 6 of this plan. The Publish step still runs its current inline
logic until then."
```

---

### Task 6: Rewire the Publish step to use `lib/publish.js`

**Files:**
- Modify: `ai-review/action.yml`

**Interfaces:**
- Consumes: `lib/publish.js`'s six exports (Task 5) and `lib/recompute.js`'s `recompute` (unchanged).
- Produces: nothing new — this is the last wiring task in this plan.

- [ ] **Step 1: Add `PUBLISH_LIB_PATH` to the Publish step's `env:` block**

Find this exact text:

```
        RECOMPUTE_PATH: ${{ github.action_path }}/lib/recompute.js
      with:
```

Replace with:

```
        RECOMPUTE_PATH: ${{ github.action_path }}/lib/recompute.js
        PUBLISH_LIB_PATH: ${{ github.action_path }}/lib/publish.js
      with:
```

- [ ] **Step 2: Replace the Publish step's script body**

Find the entire script body (this is the full, exact current content — copy it precisely to locate the block):

```
          const prNumber = Number(process.env.PR_NUMBER);
          const passLabel = process.env.PASS_LABEL;
          const failLabel = process.env.FAIL_LABEL;
          const confidenceThreshold = Number(process.env.CONFIDENCE_THRESHOLD);
          const ciSignal = process.env.CI_SIGNAL;

          let review;
          try {
            review = JSON.parse(process.env.REVIEW_JSON);
          } catch (err) {
            // Both the review stage and its retry ended without valid
            // structured output (the intermittent claude-code-action miss).
            // Degrade gracefully rather than crashing the job: post an explicit
            // "inconclusive — re-run" review, fail the gate (safe — a review
            // that didn't complete must not read as pass), and set outputs so
            // review-gate sees a non-pass verdict. A re-run usually succeeds.
            core.warning(`Review stage returned no valid structured output after retry: ${err.message}. Publishing an inconclusive result.`);
            let salvaged = "";
            try {
              salvaged = require("fs").readFileSync(".ai-review/salvaged.md", "utf8").trim();
            } catch (e) {
              // No salvage file (step skipped, or nothing recoverable).
            }
            const inconclusiveBody = [
              "<!-- ai-review -->",
              "### ⚠️ AI Review — inconclusive (re-run required)",
              "",
              "The review model did not return a structured result after a",
              "resume-repair attempt and a full retry (a known intermittent",
              "`anthropics/claude-code-action` issue). This is **not** a",
              "code-quality judgment — the review did not complete, so the gate",
              "fails closed.",
              "",
              "**Re-run the `ai-review` job** to get a verdict.",
              ...(salvaged
                ? [
                    "",
                    "<details><summary>Unstructured model output recovered from the run (not a verdict)</summary>",
                    "",
                    salvaged,
                    "",
                    "</details>",
                  ]
                : []),
            ].join("\n");
            try {
              await github.rest.pulls.createReview({
                owner: context.repo.owner,
                repo: context.repo.repo,
                pull_number: prNumber,
                event: "REQUEST_CHANGES",
                body: inconclusiveBody,
              });
            } catch (e) {
              core.warning(`Could not post inconclusive review: ${e.message}`);
            }
            try {
              await github.rest.issues.addLabels({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: prNumber,
                labels: [failLabel],
              });
            } catch (e) {
              if (![404, 422].includes(e.status)) core.warning(e.message);
            }
            core.setOutput("verdict", "fail");
            core.setOutput("confidence", "0");
            core.setOutput("merge_risk", "high");
            core.setOutput("review_event", "REQUEST_CHANGES");
            return;
          }

          const { recompute } = require(process.env.RECOMPUTE_PATH);

          // verification_evidence is still needed below by the PR-body status
          // block, independently of the verdict computation.
          const verificationEvidence = Array.isArray(review.verification_evidence)
            ? review.verification_evidence
            : [];

          const result = recompute(review, {
            confidenceThreshold,
            ciSignal,
          });

          const {
            verdict,
            confidence,
            gateConfidence,
            mergeRisk,
            reviewEvent,
            blockers,
            counts,
            intentDeviated,
          } = result;

          core.info(
            `Gate: verdict=${verdict} confidence=${confidence} ` +
              `gateConfidence=${gateConfidence} threshold=${confidenceThreshold} ` +
              `p0=${counts.p0} p1=${counts.p1} p2=${counts.p2} p3=${counts.p3} ` +
              `test_execution=${review.test_execution || "(unset)"} ` +
              `ci_signal=${ciSignal}`
          );
          if (blockers.length) {
            core.info(`Blocking conditions: ${blockers.join("; ")}`);
          }

          const verdictLine = verdict === "pass" ? "**✅ PASS**" : "**❌ FAIL**";
          const rejectedBanner = intentDeviated ? "❌ **Rejected — wrong solution**\n\n" : "";

          // State the machine reason for every fail. Without this, a
          // deterministic override reads as unexplained and gets attributed to
          // whatever the model happened to write about in comment_markdown —
          // exactly how issue #25 came to be filed as a test-toolchain bug.
          const reasonNote =
            verdict === "fail" && blockers.length
              ? `\n> **Why the gate failed:** ${blockers.join("; ")}.\n`
              : "";

          const mismatchNote =
            review.verdict && review.verdict !== verdict
              ? `\n> ⚠️ Deterministic recomputation (**${verdict}**) overrides the model's self-reported verdict (**${review.verdict}**).\n`
              : "";

          // P2/P3 are advisory and never block (rubric.md §Severity). Say so
          // on a pass, so a reader does not wonder why nits were tolerated.
          const advisoryNote =
            verdict === "pass" && counts.p2 + counts.p3 > 0
              ? `\n> ${counts.p2} P2 / ${counts.p3} P3 finding(s) noted — non-blocking.\n`
              : "";

          // The review-stage prompt instructs the model not to prepend its own
          // verdict token / confidence-merge-risk line / HTML marker to
          // comment_markdown (this step owns that banner), but model
          // instruction-following is not guaranteed — strip any leading copy of
          // those artifacts defensively so a non-compliant response can't
          // duplicate the banner above it.
          function stripLeadingBannerArtifacts(markdown) {
            if (!markdown) return markdown;
            const verdictTokenRe = /^\*\*(?:✅ PASS|❌ FAIL)\*\*\s*$/;
            const confidenceLineRe = /^Confidence:\s*\d+\s*·\s*Merge risk:\s*\S+\s*$/i;
            const htmlCommentRe = /^<!--.*-->\s*$/;
            const lines = markdown.split("\n");
            let start = 0;
            while (start < lines.length) {
              const line = lines[start];
              if (
                line.trim() === "" ||
                verdictTokenRe.test(line) ||
                confidenceLineRe.test(line) ||
                htmlCommentRe.test(line)
              ) {
                start += 1;
                continue;
              }
              break;
            }
            return lines.slice(start).join("\n");
          }

          const commentBody = stripLeadingBannerArtifacts(review.comment_markdown);

          const body = [
            "<!-- ai-review -->",
            `${rejectedBanner}${verdictLine}`,
            ...(mismatchNote ? [mismatchNote] : []),
            ...(reasonNote ? [reasonNote] : []),
            ...(advisoryNote ? [advisoryNote] : []),
            "",
            `Confidence: ${confidence} · Merge risk: ${mergeRisk}`,
            `P0: ${counts.p0} · P1: ${counts.p1} · P2: ${counts.p2} · P3: ${counts.p3}`,
            "",
            commentBody || "_No review content returned._",
          ].join("\n");

          await github.rest.pulls.createReview({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: prNumber,
            event: reviewEvent,
            body,
          });

          const winnerLabel = verdict === "pass" ? passLabel : failLabel;
          const loserLabel = verdict === "pass" ? failLabel : passLabel;

          await github.rest.issues.addLabels({
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: prNumber,
            labels: [winnerLabel],
          });

          try {
            await github.rest.issues.removeLabel({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: prNumber,
              name: loserLabel,
            });
          } catch (err) {
            if (err.status === 404 || err.status === 422) {
              core.info(`Label '${loserLabel}' not present; skipping.`);
            } else {
              throw err;
            }
          }

          // --- PR-body checklist verification (feature: update PR body) ------
          // Reflect verified checklist items back into the PR description: tick
          // boxes the model VERIFIED (with evidence) in place, and maintain a
          // managed <!-- ai-review-status --> block with per-item status +
          // evidence. Never unticks a human-checked box; never fails the job on
          // error. Gated by the update-pr-body input. The PR body is re-fetched
          // immediately before writing to minimize races with human edits.
          if (
            process.env.UPDATE_PR_BODY === "true" &&
            Array.isArray(review.checklist) &&
            review.checklist.length > 0
          ) {
            try {
              const { data: prData } = await github.rest.pulls.get({
                owner: context.repo.owner,
                repo: context.repo.repo,
                pull_number: prNumber,
              });
              const originalBody = prData.body || "";

              const norm = (s) =>
                (s || "")
                  .toLowerCase()
                  .replace(/[`*_~]/g, "")
                  .replace(/\s+/g, " ")
                  .replace(/[.:;,\s]+$/, "")
                  .trim();
              // Count verified items per normalized text, so we tick AT MOST as
              // many boxes as there were verified items with that text. This
              // stops one verified item from ticking several distinct boxes that
              // happen to normalize identically (over-tick collision).
              const verifiedCounts = new Map();
              for (const i of review.checklist) {
                if (i && i.status === "verified" && i.text) {
                  const k = norm(i.text);
                  verifiedCounts.set(k, (verifiedCounts.get(k) || 0) + 1);
                }
              }

              // Tick matching UNCHECKED boxes only; never untick a human's box.
              const checkboxRe = /^(\s*[-*]\s*)\[ \](\s*)(.+)$/;
              let ticks = 0;
              let newBody = originalBody
                .split("\n")
                .map((line) => {
                  const m = line.match(checkboxRe);
                  if (m) {
                    const k = norm(m[3]);
                    const remaining = verifiedCounts.get(k) || 0;
                    if (remaining > 0) {
                      verifiedCounts.set(k, remaining - 1);
                      ticks += 1;
                      return `${m[1]}[x]${m[2]}${m[3]}`;
                    }
                  }
                  return line;
                })
                .join("\n");

              // Build/refresh the managed status block.
              const icon = (s) =>
                s === "verified" ? "✅" : s === "failed" ? "❌" : "❔";
              const itemLines = review.checklist
                .filter((i) => i && i.text)
                .map(
                  (i) =>
                    `- ${icon(i.status)} ${i.text}${i.evidence ? ` — ${i.evidence}` : ""}`
                );
              const evLines = verificationEvidence
                .filter((e) => e && e.command)
                .map((e) => `- \`${e.command}\`${e.result ? ` → ${e.result}` : ""}`);
              const START = "<!-- ai-review-status -->";
              const END = "<!-- /ai-review-status -->";
              const blockParts = [
                START,
                "#### 🤖 AI Review — checklist verification",
                ...itemLines,
              ];
              if (evLines.length) {
                blockParts.push("", "_Verification evidence:_", ...evLines);
              }
              blockParts.push(
                "",
                `_Last updated by ai-review · verdict: ${verdict}._`,
                END
              );
              const block = blockParts.join("\n");

              const blockRe = new RegExp(`${START}[\\s\\S]*?${END}`);
              if (blockRe.test(newBody)) {
                newBody = newBody.replace(blockRe, block);
              } else {
                newBody = `${newBody.replace(/\s*$/, "")}\n\n${block}\n`;
              }

              if (newBody !== originalBody) {
                await github.rest.pulls.update({
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  pull_number: prNumber,
                  body: newBody,
                });
                core.info(
                  `Updated PR body (ticked ${ticks} checkbox(es), refreshed status block).`
                );
              } else {
                core.info("PR body already current; no change.");
              }
            } catch (err) {
              core.warning(`Could not update PR body: ${err.message}`);
            }
          }

          core.setOutput("verdict", verdict);
          core.setOutput("confidence", String(confidence));
          core.setOutput("merge_risk", mergeRisk);
          core.setOutput("review_event", reviewEvent);
```

Replace it with:

```
          const fs = require("fs");
          const { recompute } = require(process.env.RECOMPUTE_PATH);
          const {
            stripLeadingBannerArtifacts,
            buildReviewBody,
            buildInconclusiveBody,
            tickVerifiedBoxes,
            buildStatusBlock,
            upsertStatusBlock,
          } = require(process.env.PUBLISH_LIB_PATH);

          const prNumber = Number(process.env.PR_NUMBER);
          const passLabel = process.env.PASS_LABEL;
          const failLabel = process.env.FAIL_LABEL;
          const confidenceThreshold = Number(process.env.CONFIDENCE_THRESHOLD);
          const ciSignal = process.env.CI_SIGNAL;

          let review;
          try {
            review = JSON.parse(process.env.REVIEW_JSON);
          } catch (err) {
            // Both the review stage and its retry ended without valid
            // structured output (the intermittent claude-code-action miss).
            // Degrade gracefully rather than crashing the job: post an explicit
            // "inconclusive — re-run" review, fail the gate (safe — a review
            // that didn't complete must not read as pass), and set outputs so
            // review-gate sees a non-pass verdict. A re-run usually succeeds.
            core.warning(`Review stage returned no valid structured output after retry: ${err.message}. Publishing an inconclusive result.`);
            let salvaged = "";
            try {
              salvaged = fs.readFileSync(".ai-review/salvaged.md", "utf8").trim();
            } catch (e) {
              // No salvage file (step skipped, or nothing recoverable).
            }
            const inconclusiveBody = buildInconclusiveBody(salvaged);
            try {
              await github.rest.pulls.createReview({
                owner: context.repo.owner,
                repo: context.repo.repo,
                pull_number: prNumber,
                event: "REQUEST_CHANGES",
                body: inconclusiveBody,
              });
            } catch (e) {
              core.warning(`Could not post inconclusive review: ${e.message}`);
            }
            try {
              await github.rest.issues.addLabels({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: prNumber,
                labels: [failLabel],
              });
            } catch (e) {
              if (![404, 422].includes(e.status)) core.warning(e.message);
            }
            core.setOutput("verdict", "fail");
            core.setOutput("confidence", "0");
            core.setOutput("merge_risk", "high");
            core.setOutput("review_event", "REQUEST_CHANGES");
            return;
          }

          // verification_evidence is still needed below by the PR-body status
          // block, independently of the verdict computation.
          const verificationEvidence = Array.isArray(review.verification_evidence)
            ? review.verification_evidence
            : [];

          const result = recompute(review, {
            confidenceThreshold,
            ciSignal,
          });

          const {
            verdict,
            confidence,
            gateConfidence,
            mergeRisk,
            reviewEvent,
            blockers,
            counts,
            intentDeviated,
          } = result;

          core.info(
            `Gate: verdict=${verdict} confidence=${confidence} ` +
              `gateConfidence=${gateConfidence} threshold=${confidenceThreshold} ` +
              `p0=${counts.p0} p1=${counts.p1} p2=${counts.p2} p3=${counts.p3} ` +
              `test_execution=${review.test_execution || "(unset)"} ` +
              `ci_signal=${ciSignal}`
          );
          if (blockers.length) {
            core.info(`Blocking conditions: ${blockers.join("; ")}`);
          }

          const commentBody = stripLeadingBannerArtifacts(review.comment_markdown);
          const body = buildReviewBody({
            verdict,
            confidence,
            mergeRisk,
            counts,
            intentDeviated,
            modelVerdict: review.verdict,
            blockers,
            commentBody,
          });

          await github.rest.pulls.createReview({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: prNumber,
            event: reviewEvent,
            body,
          });

          const winnerLabel = verdict === "pass" ? passLabel : failLabel;
          const loserLabel = verdict === "pass" ? failLabel : passLabel;

          await github.rest.issues.addLabels({
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: prNumber,
            labels: [winnerLabel],
          });

          try {
            await github.rest.issues.removeLabel({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: prNumber,
              name: loserLabel,
            });
          } catch (err) {
            if (err.status === 404 || err.status === 422) {
              core.info(`Label '${loserLabel}' not present; skipping.`);
            } else {
              throw err;
            }
          }

          // --- PR-body checklist verification (feature: update PR body) ------
          // Reflect verified checklist items back into the PR description: tick
          // boxes the model VERIFIED (with evidence) in place, and maintain a
          // managed <!-- ai-review-status --> block with per-item status +
          // evidence. Never unticks a human-checked box; never fails the job on
          // error. Gated by the update-pr-body input. The PR body is re-fetched
          // immediately before writing to minimize races with human edits.
          if (
            process.env.UPDATE_PR_BODY === "true" &&
            Array.isArray(review.checklist) &&
            review.checklist.length > 0
          ) {
            try {
              const { data: prData } = await github.rest.pulls.get({
                owner: context.repo.owner,
                repo: context.repo.repo,
                pull_number: prNumber,
              });
              const originalBody = prData.body || "";

              const { newBody: tickedBody, ticks } = tickVerifiedBoxes(originalBody, review.checklist);
              const block = buildStatusBlock({ checklist: review.checklist, verificationEvidence, verdict });
              const newBody = upsertStatusBlock(tickedBody, block);

              if (newBody !== originalBody) {
                await github.rest.pulls.update({
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  pull_number: prNumber,
                  body: newBody,
                });
                core.info(
                  `Updated PR body (ticked ${ticks} checkbox(es), refreshed status block).`
                );
              } else {
                core.info("PR body already current; no change.");
              }
            } catch (err) {
              core.warning(`Could not update PR body: ${err.message}`);
            }
          }

          core.setOutput("verdict", verdict);
          core.setOutput("confidence", String(confidence));
          core.setOutput("merge_risk", mergeRisk);
          core.setOutput("review_event", reviewEvent);
```

- [ ] **Step 3: Verify YAML is still syntactically valid**

Run: `python3 -c "import yaml; yaml.safe_load(open('ai-review/action.yml')); print('valid')"`
Expected: `valid`.

- [ ] **Step 4: Verify the structural guard still passes**

Run: `node --test ai-review/lib/action-refs.test.js`
Expected: PASS. This step introduces no new `id:` or `steps.<id>.` references at all — every reference (`prNumber`, `passLabel`, etc.) is a `process.env.*` read, not a `steps.*` YAML expression.

- [ ] **Step 5: Line-by-line equivalence check**

This is the highest-risk step in the whole plan — a transcription error here changes the gate's behavior. For each of these six behaviors, find it in the OLD script body above and confirm the exact same behavior exists in the NEW body (calling into `lib/publish.js` instead of inlining):

1. On a `JSON.parse` failure: posts `REQUEST_CHANGES` with the inconclusive body, adds `failLabel` only (never removes `passLabel`), sets all four outputs to the fail/inconclusive values, then `return`s — nothing after this block runs.
2. `verificationEvidence` is computed from `review.verification_evidence` (defaulting to `[]`) **before** `recompute()` is called, and is used only in the later checklist block — `recompute()` itself does not take it as an argument.
3. The label reconciliation always adds the winner label first, then attempts to remove the loser label in a `try`/`catch` that re-throws on any status other than 404/422.
4. The checklist block is gated on **three** conditions together: `UPDATE_PR_BODY === "true"` AND `Array.isArray(review.checklist)` AND `review.checklist.length > 0`. If any is false, no `pulls.get`/`pulls.update` call happens at all.
5. `pulls.update` is called **only when** `newBody !== originalBody` — an all-ready-current PR body makes no API call.
6. The final four `core.setOutput` calls are unconditional at the end of the non-error path, in the same order (`verdict`, `confidence`, `merge_risk`, `review_event`).

If any of the six diverges, fix `lib/publish.js` (Task 5) or the call site here — do not special-case the YAML to work around it.

- [ ] **Step 6: Commit**

```bash
git add ai-review/action.yml
git commit -m "refactor(ai-review): wire the Publish step through lib/publish.js

Replaces the ~340-line inline script body with calls into the pure
functions extracted in the prior commit. Every GitHub API call
(createReview, addLabels, removeLabel, pulls.get, pulls.update) stays
inline -- they need the github/context objects actions/github-script
injects at runtime.

Zero behaviour change: the six load-bearing behaviors (inconclusive-path
short-circuit and return, verification_evidence computed independently
of recompute(), label winner-then-loser ordering with 404/422 tolerance,
the three-condition checklist gate, the no-op guard on an
already-current PR body, and output ordering) were checked line-by-line
against the prior inline version before this commit."
```

---

### Task 7: Verify, push, and open the PR

**Files:** none (verification and process only).

- [ ] **Step 1: Run the complete unit test suite one more time**

Run: `node --test "ai-review/lib/**/*.test.js"`
Expected: PASS — `pass 64`, `fail 0` (21 `recompute.test.js` + 12 `metrics.test.js` + 9 `action-refs.test.js` + 22 `publish.test.js`).

- [ ] **Step 2: Run the `ai-qa` parity guard**

Run:
```bash
GQL='closingIssuesReferences(first:20){nodes{number title body state url labels(first:20){nodes{name}}}}'
JQ='[.data.repository.pullRequest.closingIssuesReferences.nodes[] | {number, title, body, state, url, labels: [.labels.nodes[].name]}]'
for f in ai-review/action.yml ai-qa/action.yml; do
  grep -qF "$GQL" "$f" && echo "OK gql  $f" || echo "DRIFT gql $f"
  grep -qF "$JQ" "$f" && echo "OK jq   $f" || echo "DRIFT jq $f"
done
```
Expected: `OK` on all four lines. This plan never touches the linked-issues resolver step, so this must be unaffected — a `DRIFT` result means something in Tasks 4 or 6 accidentally reformatted lines 411-444.

- [ ] **Step 3: Full YAML syntax check**

Run: `python3 -c "import yaml; yaml.safe_load(open('ai-review/action.yml')); print('valid')"`
Expected: `valid`.

- [ ] **Step 4: Review the cumulative diff against `main`**

Run: `git diff main -- ai-review/ .github/workflows/unit.yml`
Confirm by inspection:
- `ai-review/action.yml`: only additive step insertions (Task 4) plus the Publish step's script-body substitution (Task 6, `lib/publish.js` calls replacing inline logic) and one new `env:` line (`PUBLISH_LIB_PATH`). No `if:` condition, model routing, prompt text, or schema changed anywhere.
- `ai-review/lib/`: four new files (`metrics.js`, `metrics.test.js`, `action-refs.js`, `action-refs.test.js`, `publish.js`, `publish.test.js` — six, not four) plus the two pre-existing `recompute.js`/`recompute.test.js` untouched.
- `.github/workflows/unit.yml`: glob-discovery change only.

- [ ] **Step 5: Push the branch**

```bash
git push -u origin <branch-name>
```

(If not already on a feature branch, create one first: `git checkout -b feat/ai-review-pr-a-instrumentation main`, then re-run the commits above on it, or `git checkout -b feat/ai-review-pr-a-instrumentation` before Task 1 if starting fresh.)

- [ ] **Step 6: Open the PR**

```bash
gh pr create --base main --title "feat(ai-review): PR-A -- telemetry, structural guards, Publish extraction" --body "$(cat <<'BODY'
PR-A of the parallel-review migration (docs/superpowers/specs/2026-08-07-ai-review-parallel-review-design.md section 12). Zero behaviour change -- this is instrumentation and extraction only.

## What changed

1. Re-landed `lib/metrics.js` verbatim from the reverted `be2ab85` -- per-stage turns/cost/duration, parsed structurally rather than by grepping (both prior measurement errors came from grepping).
2. New `lib/action-refs.js` -- a guard against dangling `steps.<id>.` references and duplicate step ids, tested against the real production `action.yml`, not just fixtures.
3. Extracted the Publish step's pure logic into `lib/publish.js` -- 340 lines of previously-untested inline `github-script` now has 22 unit tests. The GitHub API calls stay inline (they need the runtime-injected `github`/`context` objects).
4. Wired telemetry into the pipeline: two new snapshot steps (Context, Repair -- the Review stage already had one) plus a `Pipeline telemetry` step that renders per-stage turns/cost/duration to the job summary. All `if: always()` / `continue-on-error` -- none can affect the verdict.
5. `unit.yml` now discovers tests by glob (`ai-review/lib/**/*.test.js`) instead of a hardcoded single path.

## What did NOT change

- `recompute.js` / `recompute.test.js` -- untouched, still 21 passing tests.
- Every `if:` condition, model-routing decision, prompt, and schema in `action.yml`.
- The four job outputs and the gate contract.
- The linked-issues resolver (`ai-qa` parity guard still passes).

## Verification

- `node --test "ai-review/lib/**/*.test.js"` -> 64/64 pass
- `parity.yml` drift guard -> in sync
- `python3 -c "import yaml; yaml.safe_load(...)"` -> valid
- Six load-bearing Publish behaviors checked line-by-line against the prior inline version (see Task 6 commit)
- 3 selftest.yml runs on this PR, compared against pre-change verdicts (see below)

## Selftest verdicts (fill in after Step 7)

| Run | Verdict | Confidence | Merge risk |
|---|---|---|---|
| 1 | | | |
| 2 | | | |
| 3 | | | |

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 7: Dispatch and monitor 3 selftest runs, comparing verdicts**

`selftest.yml` triggers automatically on `pull_request` for the PR opened in Step 6 — that is run 1. For runs 2 and 3, either push a trivial no-op commit (e.g. touch a comment) or use `gh workflow run selftest.yml -f pr_number=<this PR's number>` twice more. For each run:

```bash
gh run list --workflow selftest.yml --limit 3 --json databaseId,status,conclusion,createdAt
# once each completes:
gh run view <run-id> --json jobs --jq '.jobs[] | select(.name=="review") | .conclusion'
```

Record each run's `verdict`/`confidence`/`merge_risk` (visible in the posted PR review or via `gh api repos/<owner>/<repo>/actions/runs/<run-id>` job outputs) into the PR body table from Step 6. **The gate for this plan is that all 3 runs produce the same verdict as the pre-change action would on the same PR content** — this repo's own `selftest.yml` PR is reviewing itself, so a `pass` verdict with the per-stage telemetry table visible in the job summary is the expected, self-confirming result.

- [ ] **Step 8: Confirm the telemetry summary rendered**

On any completed selftest run, check: `gh run view <run-id> --json jobs --jq '.jobs[].steps[] | select(.name=="Pipeline telemetry")'`
Expected: `conclusion: success` (or `success` even if individual snapshots were empty — the step itself never fails). Then view the job summary in the Actions UI and confirm the "ai-review telemetry" table with per-stage turns/cost/duration is present.

---

## Plan Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-08-07-ai-review-parallel-review-design.md` §12 PR-A): "Telemetry (per-stage turns/cost/duration...)" → Tasks 2 + 4. "Extract `lib/publish.js`... moved verbatim" → Task 5 + 6. "A guard against dangling/duplicate `steps.<id>` references" → Task 3. "Gate: 3 selftest runs, identical verdicts to pre-change, per-stage numbers visible in the summary" → Task 7. No PR-A requirement is left uncovered.

**Placeholder scan:** no "TBD"/"TODO"/"add appropriate error handling" patterns present — every step either shows the exact code to write or the exact command to run with its expected output. The one open item (Task 7 Step 5's PR-branch naming) is a real decision left to whoever executes the plan, not a missing detail — a branch name is a free choice, not something this plan can determine in advance.

**Type/name consistency:** `buildReviewBody`'s parameter is `modelVerdict` (not `review.verdict`) consistently across its Task 5 definition, its Task 5 tests, and its Task 6 call site. `tickVerifiedBoxes` returns `{newBody, ticks}` consistently in its Task 5 definition, tests, and Task 6's destructured call (`const { newBody: tickedBody, ticks } = ...`, renamed at the call site because the outer scope already has a `newBody` from `upsertStatusBlock` — checked, no collision). `STATUS_BLOCK_START`/`STATUS_BLOCK_END` are module-level constants in `lib/publish.js`, used by both `buildStatusBlock` and `upsertStatusBlock` — not redefined per-function as the original inline code did (a deliberate, behavior-preserving cleanup: same two literal strings, declared once).


