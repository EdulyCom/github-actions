# `ai-review`

Runs the CI-native AI review gate against a pull request: authors a native
GitHub PR review (`APPROVE` / `REQUEST_CHANGES`) and a pass/fail label, then
exposes the verdict as this action's own outputs
(`verdict`, `confidence`, `merge_risk`, `review_event`) so the calling
workflow can gate its own heavier build/test/deploy jobs on
`verdict == 'pass'`.

The verdict comes from a real two-stage AI review: a Haiku context stage
summarizes the diff, then a diff-size-routed Sonnet/Opus review stage
performs the full rubric scan (see `ai-review/rubric.md`) and returns a
schema-validated structured result. Model IDs are **locked in the action**
(Claude primary → for context, Cursor `composer-2.5` then free; for schema
reviews, structured_output free models only — Cursor has no SO on this
gateway). The posted PR review footer names the model that
actually ran and hints to re-run the job for another pass. The `Publish review`
step never trusts
the model's self-reported verdict directly — it deterministically
recomputes confidence, verdict, and merge risk from the model's reported
P0-P3 finding counts and test-quality signals, then posts that as a native
PR review and label. Everything *around* the model calls is the harness:
identity resolution, fork/draft/closed guards, stale-label clearing,
prior-review reset, and the output wiring a consumer's gate job depends on.

See
[`docs/adr/0001-ci-native-ai-review-gate.md`](../docs/adr/0001-ci-native-ai-review-gate.md)
for why the gate is an ordinary job output rather than an identity-pinned
Check Run (a), why the authoring identity is cosmetic (b), and why this is
a composite action consumed via a thin caller workflow rather than a
reusable workflow (c). Every value bound into a `script:`/`run:` body below
is passed via `env:` and read back from `process.env`/`$VAR` — never
interpolated with `${{ }}` inside the body itself — per this repo's
injection-safety rule.

## What each run does

1. **Author token** — if `app-id` and `private-key` are both set, mints a
   job-scoped GitHub App installation token limited to
   `pull-requests: write` and `issues: write` (never the installation's
   full permission set). Otherwise falls through to `github-token`.
2. **Resolve author identity** — settles on one token and one identity
   string (`<app-slug>[bot]` or `github-actions[bot]`) reused by every
   later step, so "which bot posted this" is derived once, consistently.
3. **Resolve PR number** — `pr-number` input if set, else the triggering
   `pull_request` event's number. Fails loudly if neither is available
   (e.g. a misconfigured `workflow_dispatch`).
4. **Fork guard** — a `pull_request` run whose head repo differs from its
   base repo skips every remaining step (logs
   `skipped — fork; maintainer can workflow_dispatch`) rather than
   attempting to post with permissions a fork run doesn't have.
5. **Clear stale labels on new commit** — on a `synchronize` event, removes
   all four labels (`pass-label`, `fail-label`, `qa-pass-label`,
   `qa-fail-label`) if present, so a stale badge from the previous commit
   never lingers next to new commits. Runs even on a draft PR.
6. **Draft/closed gate** — `gh pr view` the PR; a draft, closed, or merged
   PR skips every remaining step (logs `skipped — PR is draft or closed`).
7. **Checkout / deterministic prep and model routing** — checks out the PR
   head commit, then resolves the merge base, decides **full vs delta**
   review from the last published `<!-- ai-review -->` meta (unless
   `force-full-review` is set), writes `.ai-review/delta.json` and optional
   `.ai-review/prior-review.md`, and stages the changed-file list for the
   *active* range (delta = commits after the prior review HEAD; full =
   merge-base…HEAD), each file's full byte size at HEAD, a symbol manifest
   from the diff hunk headers, and the Conventional-Commits title check into
   `.ai-review/manifest.json`. Manifest `base_sha`/`head_sha` stay the PR
   merge-base and HEAD for telemetry; `review_mode` /
   `delta_base_sha` / `prior_head_sha` describe the active range. The review
   stage is told to trust those values instead of re-deriving them in paid
   model turns — a model that derives the diff base from a false premise
   reviews the wrong range and reports confidently on it.

   The same step routes ordinary diffs to the locked Sonnet primary
   (`claude/claude-sonnet-5`), escalating to Opus (`claude/claude-opus-5`)
   once a diff exceeds **either** `sonnet-files-threshold`
   (25) or `sonnet-churn-threshold` (800). These were briefly 3/60, which
   sent nearly every real PR to Opus and moved the review stage from
   ~10-13 min to a 35-min median. Widened 15/400 → 25/800 after measuring
   682 review jobs across the consumer repos: 89% of all traffic still
   routed to Opus, and Opus runs cost 3x the wall-clock and 4x the spend of
   Sonnet ones. Still a **stopgap** — the real fix is reviewing in parallel
   rather than in series, and both thresholds are removed once that lands.

   It also writes `.ai-review/assignments.json`: the review roster —
   related changed files clustered, then packed into

   ```
   K = clamp(max(ceil(total_fullfile_bytes / 130 KB),
                 ceil(changed_files / 20)), 1, 4)
   ```

   coverage reviewers, plus the tracer, intent, history and scorer roles.
   Both axes matter: a diff of many small files costs per-file attention
   independent of total bytes, and a cluster exceeding *either* budget is
   split at file boundaries (never inside a file — there is no byte-range
   field in the schema) with the affected paths recorded in
   `split_clusters` for the tracer. **Nothing reads it yet** — the review
   below is still one serial session. It ships early, and best-effort, so
   the partition it asserts (bins pairwise disjoint, no stray path, union
   equal to `changed_files`) is exercised on real diffs before any model
   stage depends on it.

   The emitted `k` is how many coverage reviewers actually exist —
   `min(formula, piece count after splitting)`, and `0` on an empty diff —
   not the raw formula value: one 600 KB file computes `K=4` but is a
   single unsplittable cluster, so `k: 1`; 25 small files in one directory
   compute `K=2` but split into two pieces, so `k` can exceed the
   *cluster* count too — one cluster split into two pieces still emits
   `k: 2`.

   Because that soak *is* the justification for shipping early, the step
   emits one scrapable `ai-review-roster {json}` line per run — the same
   shape as `ai-review-metrics`, and a record on failure too, so a
   systematic roster defect is countable across repos instead of sitting
   unnoticed in a job nobody opened:

   ```bash
   gh run view <id> --repo <repo> --log | grep -o 'ai-review-roster {.*}'
   ```

   It carries `k`/`kCapped`, `maxBinBytes`/`budgetBytes`,
   `maxBinFiles`/`budgetFiles` and `overBudget`. `kCapped` separates
   `MAX_K` binding from everything else, and an over-budget `maxBinFiles`
   with an in-budget `maxBinBytes` separates atomic clusters that cannot
   balance on file count. A bytes-only overflow does not by itself say
   whether the cause was one indivisible file over `BUDGET_BYTES` or
   several smaller atomic clusters that could not be packed to fit —
   both look identical in the telemetry.

   Two output contracts live in `roles[]`: every role writes
   `.ai-review/findings/<role>.json` **except** `scorer`, which writes
   `.ai-review/scores.json`. Each role states its own path in `artifact`,
   and `findings_roles` is the pre-filtered list to hand aggregation as its
   `roster` — passing all of `roles[]` would demand a findings file from
   the scorer and fail every run.
8. **Resolve linked issues** — deterministically resolves every issue the
   PR closes (closing keywords *and* GitHub's linked-issue graph, via the
   PR's `closingIssuesReferences`) into `.ai-review/linked-issues.json`.
   The review stage uses each linked issue's acceptance criteria as the
   primary intent contract for the rubric's Angle H. ai-review only
   **reads** linked issues; it never mutates issue state (that is `ai-qa`'s
   post-merge job).
9. **Context stage (Haiku)** — summarizes the diff and its
   callers/callees/related helpers into `context.md` for the review stage
   to read. This stage is **best-effort** (`continue-on-error`): `context.md`
   is a non-essential optimization the review reads only "if present", so a
   flaky Anthropic gateway or plugin-marketplace load that hangs/errors this
   cheap Haiku call degrades gracefully instead of sinking the whole review.
   (Composite-action steps cannot set `timeout-minutes`; the caller job's
   `timeout-minutes` is the wall-clock backstop — see the consumer guide.)
   Set `enable-context-stage: 'false'` to skip this stage entirely; the
   review reads `context.md` only "if present", so the gate is unaffected.
10. **CI inventory + signal** — on every PR event (not only
    `workflow_dispatch`), inventories check runs for the PR HEAD into
    `.ai-review/ci-checks.json` and parses the PR Test Plan / checklists into
    `.ai-review/test-plan-items.json`. Also derives an aggregate
    `pass`/`fail`/`timeout`/`no_ci` signal for Publish when every returned
    check has completed (a first `pull_request` run usually stays `no_ci`
    while sibling jobs are still running).
11. **Review stage (Sonnet/Opus)** — runs the full rubric scan against the
    diff and returns a schema-validated structured result (verdict,
    confidence, merge risk, intent alignment, P0-P3 counts, test-quality
    signals, the review markdown body, optional `verification_evidence`, and
    a `test_execution` outcome). Uncovered Test Plan items vs CI become
    normal findings; the `checklist` field is left empty (Publish no longer
    ticks boxes). It
    reads **complete file contents** (never just diff hunks) and evaluates
    the diff against the linked issues' acceptance criteria. It does **not**
    run the project's tests — see
    [Why the review no longer runs tests](#why-the-review-no-longer-runs-tests);
    test *quality* is still assessed statically and still blocks the gate.
    It loads the live
    `/requesting-code-review` and `/verification-before-completion` skills
    from the superpowers plugin: no `pass`/verified claim is accepted
    without cited command output ("evidence before claims"). `claude-code-action`
    intermittently ends a successful session without emitting the structured
    output and exits 1. Three fallbacks recover this, cheapest first: a
    **structured-output repair** step resumes that same session and asks only
    for the JSON (the analysis is already done — this is a cheap ask, not a
    re-review); if that also misses, a 45s back-off then a **retry stage**
    re-runs the review from scratch — but only when the first attempt
    finished inside a budget (a full re-review after a long first attempt
    cannot complete before the caller's timeout, so it is skipped); if every attempt misses, a **salvage**
    step extracts the model's last prose from the execution log so the
    completed analysis isn't discarded. Publish (below) still degrades
    gracefully in that final case — it posts an explicit "inconclusive —
    re-run required" review (with the salvaged prose attached, when
    available) and a `fail` verdict rather than crashing the job, so a
    required `review-gate` fails safe (never a false pass) and a re-run
    recovers it. See ADR 0004 for the full rationale.
12. **Reset prior review and labels** — dismisses this action's own prior
    `APPROVED`/`CHANGES_REQUESTED` review on the PR (a `COMMENTED` review
    can't be dismissed via the API and is left alone), **collapses every prior
    ai-review review by this bot as `OUTDATED`** (GraphQL `minimizeComment`,
    scoped by the `<!-- ai-review -->` marker so human reviews are never
    touched — non-fatal if the token can't minimize), and removes all four
    labels, so a re-run supersedes cleanly and stale reviews are hidden instead
    of stacking up visibly.
13. **Publish review** — deterministically recomputes the verdict from the
    review stage's structured output (a `pass` claiming green tests without
    any `verification_evidence` is penalized, not trusted) and posts it as a
    native PR review and the corresponding pass/fail label, then sets the
    four job outputs. It does **not** tick PR description checklist boxes
    or write an `<!-- ai-review-status -->` block (`update-pr-body` is
    accepted but is a no-op for that path). Test Plan gaps are already
    findings from the review stage.

## Inputs

| Name | Description | Required | Default |
| --- | --- | --- | --- |
| `app-id` | GitHub App ID. Optional — with `private-key`, reviews/labels are authored as `<app-slug>[bot]` instead of `github-actions[bot]`. Cosmetic only; see ADR 0001 (b). | No | — |
| `private-key` | GitHub App private key, paired with `app-id`. | No | — |
| `github-token` | Fallback token used when `app-id`/`private-key` are not set. | No | `${{ github.token }}` |
| `pr-number` | Pull request number to review. Defaults to the triggering event's `pull_request.number`; required for `workflow_dispatch`. | No | — |
| `pass-label` | Label applied when the verdict is a pass. | No | `✓ /ai-review` |
| `fail-label` | Label applied when the verdict is a fail. | No | `✗ /ai-review` |
| `qa-pass-label` | Post-merge `ai-qa` pass label; cleared (not applied) by this action on every new commit. | No | `✓ /ai-qa` |
| `qa-fail-label` | Post-merge `ai-qa` fail label; cleared (not applied) by this action on every new commit. | No | `✗ /ai-qa` |
| `confidence-threshold` | Minimum **blocking-finding** confidence (0-100) required for a pass. The Publish step recomputes confidence from the review stage's P0/P1 counts and test-quality signals and compares it against this threshold. P2/P3 findings lower the *reported* confidence but are advisory and never block. | No | `90` |
| `sonnet-files-threshold` | Max changed-file count for a diff to still route to the locked Sonnet primary (must hold together with `sonnet-churn-threshold`); larger diffs route to Opus. | No | `25` |
| `sonnet-churn-threshold` | Max changed-line count (adds + deletes) for a diff to still route to Sonnet. | No | `800` |
| `enable-context-stage` | When `false`, skips the Haiku context stage (and its `context.md` verification) entirely. The stage is best-effort and its output optional, so disabling it removes a wall-clock risk without changing the gate contract. | No | `true` |
| `api-timeout-ms` | Per-request timeout (ms) for every Claude stage, passed as `API_TIMEOUT_MS` (CLI default `600000`). **Does not bound the ~27.5-min stall** — a run with this set to `180000` still stalled 27m36s. It is a genuine per-request bound and fails a wedged request faster than the default, nothing more. | No | `180000` |
| `test-command` | **DEPRECATED — accepted but ignored.** The Review stage no longer runs tests; see [Why the review no longer runs tests](#why-the-review-no-longer-runs-tests). | No | — |
| `test-hint` | **DEPRECATED — accepted but ignored.** Same reason as `test-command`. | No | — |
| `update-pr-body` | Accepted for compatibility. Checklist tick / status-block write-back is **retired**; the input is a no-op. Test Plan gaps are findings vs CI instead. | No | `true` |
| `update-linked-issues` | When `true`, the Review stage resolves and evaluates the issues the PR closes. ai-review only reads them; it never mutates issue state. | No | `true` |
| `force-full-review` | When `true`, always review merge-base…HEAD instead of a delta since the last published ai-review. | No | `false` |

## Delta reviews

On re-runs, prep looks for the latest published review body with
`<!-- ai-review -->` and a parseable
`<!-- ai-review-meta head_sha=… base_sha=… mode=full|delta -->` line.
When that prior `head_sha` is an ancestor of the current HEAD and the
merge-base matches, the active range is **delta** (`prior_head…HEAD`) —
smaller numstat / must-read set, with `.ai-review/prior-review.md` for
finding carry-forward. Full mode is used on first run, missing/inconclusive
meta, force-push (non-ancestor), base SHA change, or `force-full-review: true`.

## Test Plan ↔ CI

The review does **not** execute the Test Plan and does **not** mark checklist
items verified in the PR body. Prep inventories:

- `.ai-review/test-plan-items.json` — items from a `Test Plan` section and/or
  `- [ ]` / `- [x]` checkboxes in the PR body
- `.ai-review/ci-checks.json` — check runs for the PR HEAD (`name`,
  `conclusion`, `status`), fetched on all PR events

The model maps items to CI coverage; uncovered or weakly covered items become
normal `findings[]` with severity P0–P3 via the rubric (then `recompute.js`).
Checklist tick write-back is retired (`update-pr-body` is a no-op for that
path). `test_execution` stays `"skipped"` — no test runners in the allowlist.

## Outputs

| Name | Description |
| --- | --- |
| `verdict` | `pass` or `fail`. Empty when the review was skipped (fork PR, draft, or closed) — a consumer's gate should treat empty the same as `fail`. |
| `confidence` | Confidence score, 0-100. |
| `merge_risk` | `low`, `medium`, or `high`. |
| `review_event` | GitHub review event posted: `APPROVE` or `REQUEST_CHANGES`. |

## Why the review no longer runs tests

The Review stage used to be told to run the project's test suite. It no longer is, and
`test-command` / `test-hint` are accepted but ignored.

**It never actually ran.** No consumer ever set `test-command`, no caller installs a
toolchain before the action, and this action ships none of its own
([ADR 0003](../docs/adr/0003-intent-alignment-test-execution-and-writeback.md) §2). Every
sampled run reported `test_execution: skipped` after probing and failing —
`node_modules exists: false`, no `npm`/`npx`/`yarn`/`pnpm`/`jest` on `PATH`, `nx` →
`Cannot find module`. Since
[ADR 0004](../docs/adr/0004-non-blocking-findings-and-structured-output-repair.md) §2 makes
`skipped` a **zero** confidence adjustment, those turns never moved a verdict either.

**Supporting it carried real risk.** The Review stage is checked out at the **PR head
commit**. Allowlisting `npm`/`npx`/`yarn`/`pnpm`/`node`/`make`/`pytest` so it *could*
run tests meant PR-authored scripts — a modified `package.json` `test` script, say —
had a permitted path to execute on the runner, which for self-hosted fleets is
persistent shared infrastructure. Those entries are now removed from `--allowedTools`,
so this is enforced structurally rather than by prompt instruction.

**Tests still gate your merges.** They run in your own CI lanes, downstream of this
gate via `needs: [review-gate]` — typically sharded, coverage-merged, and
threshold-enforced, which is strictly more than a single `npm test` inside a review
could do. A failing suite blocks the merge there.

**Test *quality* is still reviewed, and still blocks.** `no_tests_for_changed_logic`
(−15) and `coverage_below_threshold_on_critical_paths` (−5) are static judgments made
by reading the diff against the repo's existing tests. "You changed auth and added no
tests" remains an ai-review finding.

## Usage

This is the same shape shown in `docs/consumer-integration.md`, section 2a
(App credentials are optional; one of `anthropic-api-key` or
`anthropic-auth-token` is required for the review stage to call the model):

```yaml
concurrency:
  group: ci-pr-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  ai-review:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    permissions:
      contents: read
      pull-requests: write
      issues: write
    outputs:
      verdict: ${{ steps.review.outputs.verdict }}
    steps:
      - uses: EdulyCom/github-actions/ai-review@main
        id: review
        with:
          app-id: ${{ vars.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
          anthropic-auth-token: ${{ secrets.ANTHROPIC_AUTH_TOKEN }}

  review-gate:
    runs-on: ubuntu-latest
    needs: [ai-review]
    permissions: {}
    steps:
      - name: Require a passing AI review verdict
        env:
          VERDICT: ${{ needs.ai-review.outputs.verdict }}
        run: |
          if [ "$VERDICT" != "pass" ]; then
            echo "AI review verdict was '$VERDICT', not 'pass'." >&2
            exit 1
          fi

  # Your existing heavy jobs, gated on review-gate:
  build:
    needs: [review-gate]
    runs-on: ubuntu-latest
    steps:
      - run: echo "build steps go here"
```

`pull-requests: write` and `issues: write` are required only by the
`ai-review` job (for `createReview`/`addLabels`/`dismissReview`), so they're
scoped there rather than at workflow level — `review-gate` and `build` need
no repo permissions at all.

## Self-test

This repo's own `.github/workflows/selftest.yml` exercises the full path
end to end: it runs `ai-review` on this repo's own PRs and a `gated-demo`
job `needs: [review]` with `if: needs.review.outputs.verdict == 'pass'` —
proving the `verdict` output actually gates a downstream job, not just that
the action runs without error. Since the verdict now comes from a real
model review, `gated-demo` runs only when the review stage's findings
clear the confidence threshold with no P0/P1s and no failing required CI;
check the `review` job's log for the PR review and label it posted, and
confirm `gated-demo` shows as skipped instead on a draft PR or a PR that
fails review.
A `synchronize` push (a new commit on an existing PR) should show the
stale labels being cleared, the prior review being dismissed, and a fresh
review/label being published, reflecting the latest commit's own verdict.
