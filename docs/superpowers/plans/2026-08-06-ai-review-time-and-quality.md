# ai-review: Time, Quality, and Defect-Correction Program

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **Supersedes** `docs/superpowers/plans/2026-08-06-ai-review-simplification.md`, which was written on inference before anything was measured. Do not execute that plan.

**Goal:** Bring the ai-review gate from a measured p95 of ~50-59 min to a p95 ≤ 20 min with a 25-min bound, make its quality and cost measurable rather than assumed, and correct eleven product defects found during measurement.

**Architecture:** Instrument first, then correct the existing serial pipeline, then build and prove a matrix fan-out offline, then shadow it in production, then cut over. Every phase gate is a number produced by the telemetry built in Phase 0 — not a judgment. Two decision points belong to the user, not to this plan.

**Tech Stack:** GitHub Actions (composite today, reusable workflow from Phase 2), `anthropics/claude-code-action@v1.0.177` (CLI 2.1.214), `actions/github-script`, `gh` CLI, Node.js `node:test` (no third-party deps).

---

## The measurement this plan exists to fix

Sampled from `EdulyCom/eduly` CI, 2026-08-05/06:

| | |
|---|---|
| 59-min job breakdown | Review stage **56m04s** · Haiku context 2m58s · everything else ~20s |
| Repair / back-off / retry / salvage | **All skipped. Zero contribution.** |
| Review stage across 10 runs | 31→166 turns · 6→59 min · **$1.74→$38.59** |
| Relationship | **duration ≈ turns × ~24s.** Turns, wall-clock, and cost are one lever. |
| 25 successful jobs | mean 34.6 min · max 59 |
| Killed by caller timeout | 2 at `timeout-minutes: 60`; 5 at a prior 40-min cap |

## Ruling: what "optimize the test" means

**Primary — the review-as-gate.** Goal 2 is not redundant with goal 1: time is minutes; optimization is cost visibility, inconclusive rate, findings recall, and fail-closed behaviour.

**Secondary, as a means — the dev loop.** The entire defect inventory below exists because nothing in this action can be tested for less than a ~$20 live run. Restructuring the pipeline before building a cheap harness would repeat exactly the mistakes that produced the inventory. Phases 0-1 build the harness because no later gate is enforceable without it.

---

## Global Constraints

- **No new runtime or test dependencies.** No `package.json`. Tests use `node:test`, `node:assert/strict`, `node:fs`, `node:path` only.
- **All third-party actions SHA-pinned** with their `# vX.Y.Z` comment (D13).
- **`--max-turns` is BANNED.** It exits with an error rather than returning partial output, and on abort `session_id` survives — so the repair step ([action.yml:710-743](../../../ai-review/action.yml#L710-L743)) fires first and instructs the model to emit output "from the analysis you already completed," laundering a review cut off mid-scan into a confident published verdict. Salvage never runs.
- **In-process subagents are REJECTED** until upstream fixes *both* [#1499](https://github.com/anthropics/claude-code-action/issues/1499) (wrapper breaks the message loop on first `result`, orphaning background subagents) and [#1515](https://github.com/anthropics/claude-code-action/issues/1515) (model narrates parallel dispatch and ends the turn; subagents never execute; run reports `success` — ~30-43% of heavy runs, **no fix filed**), and the fixes have soaked.
- **Forking/vendoring the wrapper is REJECTED.** A patched wrapper can only *drain* orphaned tasks (#1499). In #1515 the subagents never executed — there is nothing to drain.
- **Rubric content is not a variable.** It is the quality bar. `/requesting-code-review` and `/verification-before-completion` requirements are preserved everywhere.
- **Injection safety (ADR 0001/0003).** Attacker-influenceable content is bound via `env:` and read as files. Model output may be tested for emptiness (`[ -z "$VAR" ]`); never echoed into a command.
- **Do not reformat the linked-issue resolver.** `parity.yml` `grep -qF`-checks two exact strings in both `ai-review` and `ai-qa`.
- **Per-phase file budget.** Written into each phase, checked at its gate. Guards against the 8-new-files-for-a-simplification failure.

---

# Phase 0 — Instrument

**Goal:** Make every later gate a measured number. Make cost visible per run.

**Must not touch:** prompts, routing, pipeline structure, publish logic. Zero behaviour change.

**File budget:** ≤ 3 new files.

**Lands:** A10 (fix), A4 part 1 (fix), durable guards for B1–B4.

### Task 0.1 — Programmatic telemetry

**Files:** Create `ai-review/lib/metrics.js`, `ai-review/lib/metrics.test.js`. Modify `ai-review/action.yml` (new step), `.github/workflows/unit.yml:29`.

**Interfaces:** `collectMetrics(stages: {name, execFilePath}[]): {stages: [{name, turns, costUsd, durationMs, model, numToolCalls}], totals: {...}}`

- [ ] **Step 1: Write the failing test**

`ai-review/lib/metrics.test.js` — assert against a committed fixture execution log:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseExecutionLog } = require("./metrics.js");

test("parses turns, cost, and duration from an execution log", () => {
  const log = [
    { type: "system", subtype: "init", model: "claude-opus-4-8" },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } },
    { type: "result", subtype: "success", num_turns: 138,
      total_cost_usd: 31.008854, duration_ms: 3363956 },
  ];
  const m = parseExecutionLog(log);
  assert.equal(m.turns, 138);
  assert.equal(m.costUsd, 31.008854);
  assert.equal(m.durationMs, 3363956);
  assert.equal(m.model, "claude-opus-4-8");
  assert.equal(m.numToolCalls, 1);
});

test("a missing result block yields nulls, not a throw", () => {
  const m = parseExecutionLog([{ type: "system", subtype: "init" }]);
  assert.equal(m.turns, null);
  assert.equal(m.costUsd, null);
});

test("counts tool calls by name", () => {
  const log = [
    { type: "assistant", message: { content: [
      { type: "tool_use", name: "Bash" }, { type: "tool_use", name: "Bash" },
      { type: "tool_use", name: "Read" }] } },
    { type: "result", num_turns: 3, total_cost_usd: 0.1, duration_ms: 100 },
  ];
  assert.deepEqual(parseExecutionLog(log).toolCalls, { Bash: 2, Read: 1 });
});
```

> **Why `parseExecutionLog` takes a parsed array and never greps.** Two measurement errors in this program's own history came from grepping logs: a 22-entry `--allowedTools` allowlist echoed 3× was reported as "66 Bash tool calls," and `head -1` on a job log reported the Context stage's turns and cost as the Review stage's. Structured parse with explicit per-stage attribution is the durable guard (B2, B3).

- [ ] **Step 2: Run to verify it fails** — `node --test ai-review/lib/metrics.test.js` → `Cannot find module './metrics.js'`

- [ ] **Step 3: Implement `metrics.js`** — `parseExecutionLog(entries)` returns `{turns, costUsd, durationMs, model, numToolCalls, toolCalls}`, tolerating a missing `result`. `collectMetrics(stages)` maps stage name → parsed metrics plus a totals roll-up. Pure: no I/O, no `process.env`.

- [ ] **Step 4: Run to verify it passes** — `node --test ai-review/lib/metrics.test.js`

- [ ] **Step 5: Add the telemetry step to `action.yml`**

Place after `Publish review`, with `if: always() && <gate>`. It reads each stage's `execution_file` (review's comes from the existing snapshot at `${RUNNER_TEMP}/ai-review-exec-review-snapshot.json`), calls `collectMetrics`, writes `metrics.json` as an artifact, and renders a table to `$GITHUB_STEP_SUMMARY`. Best-effort: never fails the job.

- [ ] **Step 6: Point unit.yml at the directory** — replace `node --test ai-review/lib/recompute.test.js` with `node --test "ai-review/lib/**/*.test.js"`

- [ ] **Step 7: Commit**

```bash
git add ai-review/lib/metrics.js ai-review/lib/metrics.test.js ai-review/action.yml .github/workflows/unit.yml
git commit -m "feat(ai-review): per-stage turn/cost/duration telemetry

Every later phase gate is a number from metrics.json rather than a
judgment. Parses the execution log structurally — the two prior
measurement errors in this program both came from grepping it."
```

### Task 0.2 — Honest lint

**Files:** Modify `.github/workflows/actionlint.yml`.

- [ ] **Step 1: Record the gap** — actionlint's docs: *"Note that `steps` in Composite action's metadata is not checked at this point."* `reviewdog/action-actionlint` passes no globs, so it discovers only `.github/workflows/`. The job named **"Lint workflow and action files" does not lint action files.**
- [ ] **Step 2: Add `action-validator`** (SHA-pinned) over `*/action.yml` for metadata-schema validation.
- [ ] **Step 3: Add `shellcheck`** over composite `run:` blocks — coverage grows as Phase 1 extracts logic.
- [ ] **Step 4: Rename the job** to what it actually checks, and comment the residual gap (composite `steps` semantics remain unchecked upstream).
- [ ] **Step 5: Commit** — `fix(ci): lint action metadata, and name the lint job honestly`

### Task 0.3 — Baseline

**Files:** Create `docs/ai-review-baseline.md`.

- [ ] **Step 1:** Record the sampled table above plus per-stage metrics from ≥3 runs carrying Phase-0 telemetry.
- [ ] **Step 2: Commit** — `docs(ai-review): record the pre-change performance baseline`

### Phase 0 gate

- [ ] Telemetry visible on ≥3 real runs
- [ ] Baseline distribution table committed
- [ ] `node --test "ai-review/lib/**/*.test.js"` green; new lint jobs green
- [ ] ≤ 3 new files
- [ ] **Zero behaviour change** — verdicts on the 3 runs match what the un-instrumented pipeline would have produced

---

# Phase 1 — Correct the current pipeline

**Goal:** Kill measured waste and the correctness hazard on the *existing serial path*; make its bug-prone logic testable. Route-independent — none of this is thrown away if the matrix route is later declined.

**Must not touch:** rubric content, model routing, output-schema *content*, publish semantics, fan-out.

> **The `route` step ([action.yml:354-393](../../../ai-review/action.yml#L354-L393)) must survive Phase 1 untouched.** It looks like dead weight next to the pre-stage — both compute diff stats — but it becomes the Phase 2 **topology router** (tiny → serial, otherwise → matrix). Deleting or folding it here would have to be rebuilt. Nothing else in Phase 1 is model-aware.

**File budget:** ≤ 5 new files.

**Lands:** A1, A3, A5, A6, A7 (scoped), A9 — fix. A8 — document. A2 deferred to Phase 3; it cannot be fixed serially.

### Task 1.1 — A1: deterministic context pack (the correctness fix)

**The defect, corrected from the original brief.** This is **not** a misconfigured checkout. The runner log proves `fetch-depth: 0` was honoured:

```
git -c protocol.version=2 fetch --no-tags --prune --no-recurse-submodules \
    origin +refs/heads/*:refs/remotes/origin/* +refs/tags/*:refs/tags/*
```

No `--depth`, all heads, all tags — full history, `origin/develop` included. Yet the same run's model-authored `verification_evidence` claims:

> *"Repo is shallow (`git rev-parse --is-shallow-repository` => true), so `git merge-base origin/develop HEAD` exits 1; 8ee32e993 … is the correct base"*

Machine-generated runner output and model-authored evidence contradict each other. The likely reading: **the model asserted a false premise about the repository and chose the diff base by hand on the strength of it** — under a prompt whose `/verification-before-completion` discipline exists to prevent exactly that. The hazard is not shallow history; it is that *which diff gets reviewed* is a model judgment that can be silently wrong with a plausible justification attached.

**Files:** Modify `ai-review/action.yml` (new prep step + prompt edit).

- [ ] **Step 1: Write the prep step** — emits `.ai-review/context-pack.json`: `head_sha`, `base_sha` (computed deterministically from `gh pr view --json baseRefName` + `git merge-base`), `default_branch`, `changed_files[]`, `churn`, and `toolchain` (a probe: does `node_modules` exist; are `npm`/`yarn`/`pnpm`/`pytest` on `PATH`). Also writes `diff.patch`.
- [ ] **Step 2: Assert the anomaly is moot** — the prep step logs `git rev-parse --is-shallow-repository` and the computed `base_sha`, so the contradiction is visible in every run's plain log and root-causeable without archaeology.
- [ ] **Step 3: Edit the review prompt** — "A deterministic step has established the head SHA, base SHA, changed-file list, and toolchain availability in `.ai-review/context-pack.json`. **Trust these. Do not re-derive the base, do not probe the toolchain.**" Preserve every rubric and evidence instruction verbatim.
- [ ] **Step 4: Verify on a real PR** — transcripts contain no `git merge-base` / `is-shallow-repository` / `which yarn npx jest` turns.
- [ ] **Step 5: Commit** — `fix(ai-review): hand the review a deterministic diff base and toolchain probe`

> A3 is fixed by the same prompt edit: ADR 0003 §2 states the caller provisions no toolchain, yet every run re-discovers it (`which yarn npx jest node pnpm npm` all absent, `nx` → MODULE_NOT_FOUND, `test_execution=skipped`).

### Task 1.2 — A5: single-source the output schema

**Files:** Create `ai-review/lib/review-schema.json`. Modify `ai-review/action.yml` (new assemble-args step; lines 580, 730, 793). Append assertions to `ai-review/lib/recompute.test.js`.

- [ ] **Step 1:** Append to `recompute.test.js` — schema `intent.enum` includes `deviated`; `test_execution.enum` includes `failed` and `passed`; `counts` keys are exactly `p0,p1,p2,p3`; and the schema string appears **zero** times in `action.yml`. Run → fails (`ENOENT`).
- [ ] **Step 2:** Create `review-schema.json` by copying the JSON at `action.yml:580` **verbatim**, then pretty-printing.
- [ ] **Step 3:** Add an assemble-args step emitting `jq -c . "$GITHUB_ACTION_PATH/lib/review-schema.json"` to a step output. `--json-schema` accepts inline JSON only — the CLI documents no file-path form — so this routes through a step output.
- [ ] **Step 4:** Replace all three inline copies with `--json-schema '${{ steps.schema.outputs.json }}'`. Run tests → pass.
- [ ] **Step 5: Commit** — `refactor(ai-review): single source of truth for the output schema`

### Task 1.3 — A9: compute the retry gate once

**Files:** Modify `ai-review/action.yml` (new step; `:754-761`, `:771-778`, comment at `:749-753`).

- [ ] **Step 1:** Insert a `retry-gate` step after the repair step computing `needed` from `steps.review.outcome`, `steps.review.outputs.structured_output`, and `steps.review_repair.outputs.structured_output` — all bound via `env:`, tested only with `-z`.
- [ ] **Step 2:** Replace both five-line `if: >-` blocks with `if: steps.retry-gate.outputs.needed == 'true'`.
- [ ] **Step 3:** Delete the "must be kept identical" drift warning; the hazard no longer exists.
- [ ] **Step 4: Commit** — `refactor(ai-review): compute the retry gate once`

### Task 1.4 — A6 + A7: extract the bug-prone pure logic

Scoped deliberately. A wholesale rewrite of the 346-line Publish step inside a hygiene phase is the same failure shape as proposing 8 new files for a simplification. Extract **only** what is bug-prone and untestable today.

**Files:** Create `ai-review/lib/publish.js`, `ai-review/lib/publish.test.js`. Modify `ai-review/action.yml` (`:294-317`, `:1025-1046`, `:1140-1176`, `:1211-1322`, `:965-981`).

**Interfaces:** `stripLeadingBannerArtifacts`, `buildReviewBody`, `buildInconclusiveBody`, `normalize`, `tickVerifiedBoxes`, `buildStatusBlock`, `upsertStatusBlock`, `removeLabels`.

- [ ] **Step 1: Write the failing tests.** Highest-value case first — the over-tick collision guard ([:1238-1248](../../../ai-review/action.yml#L1238-L1248)), which writes to the author's PR description:

```js
test("over-tick guard: one verified item ticks at most one colliding box", () => {
  const { body, ticks } = tickVerifiedBoxes(
    "- [ ] Adds tests\n- [ ] **Adds `tests`.**",
    [{ text: "Adds tests", status: "verified" }]
  );
  assert.equal(ticks, 1, "must not tick both boxes from one verified item");
  assert.equal(body, "- [x] Adds tests\n- [ ] **Adds `tests`.**");
});

test("never unticks a human-checked box", () => {
  const { body, ticks } = tickVerifiedBoxes("- [x] Adds tests",
    [{ text: "Adds tests", status: "failed" }]);
  assert.equal(body, "- [x] Adds tests");
  assert.equal(ticks, 0);
});

test("upsert replaces an existing status block rather than appending a second", () => {
  const out = upsertStatusBlock(
    "Body\n\n<!-- ai-review-status -->OLD<!-- /ai-review-status -->\n",
    "<!-- ai-review-status -->NEW<!-- /ai-review-status -->");
  assert.ok(out.includes("NEW") && !out.includes("OLD"));
  assert.equal(out.split("<!-- ai-review-status -->").length - 1, 1);
});
```

Plus: banner-artifact stripping (verdict token, confidence line, HTML marker, already-clean); `buildReviewBody` marker/verdict/counts, machine reason on fail, override notice, non-blocking-nits note, empty-content fallback; `buildInconclusiveBody` with and without salvage.

- [ ] **Step 2: Run to verify they fail** — `Cannot find module './publish.js'`
- [ ] **Step 3: Implement `publish.js`** — move logic **verbatim** from `action.yml`; do not retype. Preserve the existing comments (issue #25, the rubric's non-blocking severity rule, the over-tick rationale). `removeLabels(github, context, prNumber, labels, logVerb)` absorbs the loop duplicated at `:294-317` and `:965-981` (A6).
- [ ] **Step 4: Run to verify they pass**
- [ ] **Step 5: Wire the action** — add `PUBLISH_PATH` to the Publish env; hoist the `require` above the `try` (`buildInconclusiveBody` is needed in the `catch`). Keep in the action: the `try`/`catch`, the `pulls.get` re-fetch race guard, the `UPDATE_PR_BODY === "true"` condition, and the `newBody !== originalBody` no-op check.
- [ ] **Step 6: Commit** — `refactor(ai-review): extract bug-prone publish logic to lib/publish.js`

### Task 1.5 — A8: document the laundering hazard

- [ ] **Step 1:** Comment at the repair step: it must never resume an aborted or turn-limited session, and `--max-turns` is banned — on abort `session_id` survives, so repair fires *before* salvage and converts a partially-scanned review into a confident verdict.
- [ ] **Step 2: Commit** — `docs(ai-review): record why --max-turns is banned at the repair step`

### Phase 1 gate

Measured on **≥3 paired PRs** (same PR, before/after) using Phase-0 telemetry:

- [ ] Toolchain-probe and base-derivation turns **absent** from transcripts
- [ ] **Findings identical** to the pre-change run on each paired PR — no recall loss
- [ ] Mean turns down **10-20**
- [ ] `node --test "ai-review/lib/**/*.test.js"` green; lint green
- [ ] ≤ 5 new files
- [ ] **Honest expectation: 56 min → ~48-50 min. This does not meet the time goal. Phase 1 is the floor, not the fix.**

---

# Phase 2 — Build and spike the matrix offline

**Goal:** Prove the matrix route with numbers before any consumer sees it.

**Must not touch:** the production composite path. No consumer change of any kind.

**Why matrix and not subagents.** This action's design language is *deterministic steps own control flow, the model owns judgment* — deterministic verdict recompute, deterministic linked-issue resolver, deterministic publish. In-process fan-out would put orchestration **inside the model's turn**, and #1515 is precisely what that costs. Matrix moves dispatch to GitHub's scheduler, where it is harness-guaranteed, and it beats subagents on all five identified degradation modes: workspace contention becomes structurally impossible (separate runners), and silent angle death gets harness-level detection (job status + artifact presence) requiring no model cooperation.

**Scope:**
- [ ] Shard prompt templates — each angle's rubric section embedded **verbatim** (subagents/shards cannot be assumed to inherit plugin-loaded skills)
- [ ] Per-shard contract: **transport-agnostic** — `angle + intent brief in → findings JSON + completion sentinel out`. This is what lets in-process subagents later replace matrix as a *simplification* if upstream ever fixes both defects.
- [ ] `ai-review/lib/merge.js` + fixture tests — dedup on `(file, line-range, defect-class)`, rubric-119 priority (correctness A/B/C outranks cleanup D/E/F/G), counts recomputed from the deduped set. **Never invents, never silently drops** — the rubric calls silent dropping "the dominant cause of misses."
- [ ] Reusable workflow skeleton: `prep (context pack + Angle H) → matrix A–G + verification shard → merge`
- [ ] **Role-based model assignment per the table below — a requirement, not an experiment**
- [ ] **The spike:** two arms, ≥5 consecutive runs on a real heavy PR, scratch caller (see *Spike arms*)

### Model assignment — the role table

This is a **standing user instruction**: *"run opus as the planner and judge, sonnet as the tester, haiku as the fact collector and helper."* It is structurally impossible on the serial path — one `claude-code-action` invocation takes one `--model`, and the review stage is one invocation — and the in-process route that could carry per-agent models is rejected on #1499/#1515. **The matrix is the only approved architecture that can satisfy it at all.**

| Work | Model | Role |
|---|---|---|
| Prep pack — SHAs, diff, churn, toolchain probe | **none — deterministic bash** | fact collection that is *code*, not a model |
| Context / caller-callee semantic map | **Haiku** | collector |
| Angle H → intent brief | **Opus** | planner |
| Angles **A, B, C** (line-by-line, removed-behaviour, cross-file) | **Opus** | scanner — correctness |
| Angles **D, E, F, G** (reuse, simplification, efficiency, altitude) | **Sonnet** | scanner — cleanup |
| Verification + test shard | **Sonnet** | tester |
| Merge: dedup, rank, verdict synthesis | **Opus** | judge |
| Per-shard repair / retry | **same model as its shard** | — |

**Why A/B/C and D/E/F/G split.** The user's four named roles don't cover the 8-angle scan, which is the largest cost centre. All-Opus ignores the cost intent evident in assigning Sonnet and Haiku roles at all; all-Sonnet walks back ADR 0003's deliberate Opus-by-default quality choice on correctness-critical detection with zero evidence. The split's warrant is [rubric.md:119](../../../ai-review/rubric.md#L119) — *"Correctness bugs (A/B/C) always outrank cleanup/altitude (D/E/F/G) when forced to cut."* The angles whose misses are gate-critical keep the stronger model.

**Stated honestly:** D/E/F/G can still emit blocking P1s — an N+1 query is a listed P1 under Angle F. The split carries residual recall risk. That is exactly what Phase 3's per-angle gate measures.

**Repair must never cross models.** It resumes a session via `--resume`; it inherits its shard's model.

**Haiku is the designated default for every future non-judgment auxiliary model task** — the rule exists so nobody reaches for Opus out of habit. Today its only live duty is the collector map.

**Topology router.** Tiny diffs (the existing ≤3-files **and** ≤60-churn thresholds) **do not enter the matrix** — ten jobs of startup overhead for a 6-minute review is absurd, and the time problem lives in heavy diffs. They keep today's serial single-session Sonnet path unchanged. The existing `route` step becomes a *topology* router: tiny → serial, otherwise → matrix with the role table.

**Ratchet rule for changing any assignment later.** Up-model moves are **free and unilateral** — any Sonnet shard showing a missed finding-class against the serial baseline promotes to Opus immediately, no sign-off. Down-model moves require per-angle recall data at **n ≥ 10 paired runs plus user sign-off**. The burden of proof always sits on the cheaper direction.

### Spike arms — hold-then-vary

Changing topology and models together and then measuring once would make a recall failure unattributable — the same sin as designing on inference. But a full sequential double shadow doubles the expensive window. So the two variables separate **in the cheap phase**:

- **Arm T (topology-only):** every shard on the routed model (Opus). Isolates the fan-out delta against the serial baseline.
- **Arm R (role-based):** the table above. Measures the requirement.

Both run on the **same ≥3 paired PRs**. Every finding artifact carries `{shard, model}` tags so any miss attributes to an angle+model pair.

**Binding design amendments:**
- Angle H hands forward an **intent brief** (goal, acceptance criteria, in/out of scope) — **never its findings**. H writing "wrong solution, P0" into what A–G read is the cross-steering [rubric.md:14-16](../../../ai-review/rubric.md#L14-L16) forbids.
- **Verify Pass lives inside each shard**, not in merge. [rubric.md:121-132](../../../ai-review/rubric.md#L121-L132) requires per-candidate refutation constructible from code — merge cannot code-verify ~46 candidates.
- Angle shards get **read-only tools**. Test execution moves to **one dedicated verification shard** holding the exec allowlist — which also shrinks today's blast radius, where the whole review session holds exec permissions.
- Every shard writes a **completion sentinel**. Missing or malformed → the existing fail-closed inconclusive path, never a verdict.
- **Each shard keeps its own repair/retry chain.** Nine sessions multiply the known no-structured-output flake to `1−(1−p)⁹`.

### Phase 2 gate — the spike report

- [ ] Wall-clock **≤ 20 min** on a heavy PR
- [ ] Sentinels **5/5 present** across consecutive runs
- [ ] **Zero 429 re-serialization** — 8-9 concurrent sessions carry the same rate-limit exposure as in-process; this is the risk that would erase the entire benefit while still multiplying tokens
- [ ] Runner queue time recorded
- [ ] `merge.js` dedup tests green
- [ ] Recall ⊇ serial on ≥3 paired PRs — **measured for both Arm T and Arm R**
- [ ] Findings tagged `{shard, model}`; per-role cost rollup produced
- [ ] Telemetry carries a `role` field per stage (`planner|judge|tester|collector|scanner`) — delivered with the first shard PR, not a Phase 0 re-spin

### ▶ USER DECISION POINT 1 — end of Phase 2

Presented **with spike numbers in hand**. Not ours to decide:

1. **Interface migration.** Matrix cannot live inside a composite action. The contract moves from `uses: EdulyCom/github-actions/ai-review@main` to a reusable workflow — a **breaking change to eduly's caller wiring**.
2. **Cost.** Both arms' measured $/review, minutes, and inconclusive counts, side by side. With five of nine model-bearing units on Sonnet at roughly a fifth of Opus rates — and H plus merge being small-context Opus calls — the prior band revises **downward from ~0.6×–2× to roughly ~0.4×–1.2×** of today's ~$20 mean. Framing shifts from *"pay possibly more for speed"* to *"speed with likely cost reduction; residual risk is per-angle recall."* **The band is a prior, not a promise — the numbers presented are spike actuals.** Plus ~2× GitHub job-minutes (trivial dollars beside API spend, but stated).
3. **Authorization** for the Phase-3 shadow-window spend, revised downward accordingly.

**Arm R is recommended** — it is the user's own standing instruction, not our preference.

**On NO-GO:** Phases 3-4 are cancelled. Phase 0-1 gains stand. Matrix is parked pending upstream fixes plus soak.

---

# Phase 3 — Shadow in production

**Goal:** Fix A2 structurally and prove parity where it counts.

**Must not touch:** the serial path — it is the control arm, the fallback, and it stays default throughout.

**Scope:**
- [ ] Harden per the binding amendments: read-only shard tokens, pinned head SHA + `fetch-depth: 1`, artifact pack + intent brief (no shard re-derives the base — this cures the base-archaeology class permanently), per-shard repair/retry, fail-closed on missing/malformed shard
- [ ] Run matrix **side-by-side on ≥10 real eduly PRs**, with the **serial verdict governing**
- [ ] **Arm R (role-based) is the primary shadow arm** — it is the requirement, not an experiment. Arm T is the pre-characterised diagnostic: if Arm R fails the recall gate, the Phase-2 spike data already indicates which variable is suspect, and one targeted Arm-T slice isolates it definitively.
- [ ] Draft the recommended matrix caller timeout (~25 min) for Phase 4

### Phase 3 gate

- [ ] Review-level inconclusive rate **< 5%**
- [ ] **Recall parity** — matrix confirmed-findings ⊇ serial's on every paired PR; every miss investigated
- [ ] **Per-angle recall attribution** — every finding tagged `{shard, model}`, so a miss resolves to an angle+model pair rather than "the matrix"
- [ ] Wall-clock **p95 ≤ 20 min**
- [ ] $/review delta within the Decision-1 envelope

> **Ratchet in force from here on.** Any Sonnet shard that misses a finding-class the serial baseline caught promotes to Opus immediately — no sign-off, no ceremony. Quality ratchets up freely; only the cheaper direction is gated.

---

# Phase 4 — Cutover and permanence

### ▶ USER DECISION POINT 2 — entry

Rollout sign-off on the Phase-3 comparison table.

**Scope on GO:**
- [ ] Matrix becomes default for eduly
- [ ] Caller `timeout-minutes` **60 → 25** (A11) — the timeout returns to *bounding* rather than *killing*
- [ ] Serial composite documented as the supported fallback
- [ ] ADR recording the route decision, the #1499/#1515 rationale, and the `--max-turns` ban (A8 permanence)
- [ ] Mark `2026-08-06-ai-review-simplification.md` superseded
- [ ] Telemetry thresholds armed as permanent ratchets — alert on +25% drift in mean turns or cost

### Phase 4 close-out gate

- [ ] 2 weeks / ≥20 PRs at default: inconclusive < 5%, p95 ≤ 25 min, **zero timeout kills**, cost in envelope

---

## Defect dispositions

**None dropped.**

| | Defect | Phase |
|---|---|---|
| A1 | Diff base chosen by model judgment on a false premise | 1 |
| A2 | Rubric independence violated — 8 angles share one context | 3 (mechanism in 2) |
| A3 | Toolchain re-probed every run despite ADR 0003 §2 | 1 |
| A4 | `action.yml` linted by nothing; lint job misnamed | 0 + 1 |
| A5 | Schema triplicated verbatim | 1 |
| A6 | Label-removal loop duplicated verbatim | 1 |
| A7 | 346-line Publish step, ~170 lines untested | 1 (scoped to bug-prone pure functions) |
| A8 | Latent `--max-turns` → repair laundering | 1 doc + 4 ADR |
| A9 | Hand-synced duplicate `if:` on back-off/retry | 1 |
| A10 | Cost unmonitored ($1.74–$38.59/review) | 0 |
| A11 | Caller timeout kills rather than bounds | 4 (prep in 3) |

> A7 came closest to being dropped. Scoped rather than dropped: a wholesale Publish rewrite inside a hygiene phase is the failure shape this program is correcting for.

## Process guards

| | Mistake | Durable guard |
|---|---|---|
| B1 | Wrote a plan on inference when asked to measure | Phase 0 precedes all design; every gate is a metrics.json number |
| B2 | Reported an echoed allowlist as 66 tool calls | `parseExecutionLog` counts structurally; grepping logs for metrics is banned |
| B3 | `head -1` conflated Context and Review telemetry | Per-stage attribution is explicit in the metrics contract |
| B4 | Ranked the retry chain as a wall-clock factor (measured: zero) | Phase gates are paired before/after measurements, not estimates |
| B5 | Proposed 8 new files for a simplification | Per-phase file budget, checked at the gate |
| B6 | Ran director and builder in parallel; director ruled without the blocker | **Builder evidence lands before director rulings.** Never dispatch them concurrently. |
| B7 | Picked a route unilaterally and recommended it pre-ruling | **No recommendation reaches the user before the ruling.** Every phase ends measurement → ruling → next. |

## Explicitly out of scope

In-process subagents (rejected until #1499 **and** #1515 are fixed and soaked) · forking/vendoring the wrapper (cannot recover never-executed shards) · `--max-turns` (banned) · rubric content changes (it is the quality bar, not a variable) · **model assignments outside the role table — changes only via the ratchet rule (up free, down requires n ≥ 10 evidence + user sign-off)** · `ai-qa` parity (follow-up — note the linked-issues resolver sync comment) · any caller CI restructure beyond the ai-review job.

> **Haiku-stage removal is no longer a candidate.** An earlier draft listed it for post-Phase-3 review. The collector role is a standing user requirement — Haiku stays, permanently.

## Time trajectory, stated honestly

| Stage | Expected |
|---|---|
| Today | mean 34.6 min, max 59, 2 kills at 60 |
| After Phase 1 | ~48-50 min on heavy PRs — **does not meet the goal** |
| After Phases 3-4 | p95 ≤ 20 min, bounded at 25 |

Turns are the currency (~24 s/turn). Telemetry tracks turns as the leading indicator from Phase 0 onward.

---

## Detail level, deliberately uneven

Phases 0-1 are written as executable steps because they are next and route-independent. Phases 2-4 are scoped charters with hard gates because their step detail legitimately depends on measurements that do not exist yet — Phase 3's steps cannot be written before Phase 2's spike numbers. Writing them now would be invention, which is the failure this program is correcting for.
