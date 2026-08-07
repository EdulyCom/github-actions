# `ai-review`

Runs the CI-native AI review gate against a pull request: authors a native
GitHub PR review (`APPROVE` / `REQUEST_CHANGES`) and a pass/fail label, then
exposes the verdict as this action's own outputs
(`verdict`, `confidence`, `merge_risk`, `review_event`) so the calling
workflow can gate its own heavier build/test/deploy jobs on
`verdict == 'pass'`.

The verdict comes from a real AI review, run as an **Opus-orchestrated
fan-out** (`ai-review/orchestrator/`). A deterministic prep step builds the
diff and a context pack in `git` — no model is asked to find its own base
ref. Opus then establishes the intent contract, plans a set of scoped
Sonnet/Haiku worker tasks that must together cover every rubric angle (see
`ai-review/rubric.md`), dispatches them in parallel, and judges what comes
back; it may call another round if the review is not finished. Every stage
is schema-validated, and every incomplete stage is a **gap Opus must
account for** — never a clean result.

The `Publish review` step never trusts a model's self-reported verdict
directly — it deterministically recomputes confidence, verdict, and merge
risk from P0-P3 finding counts (which deterministic code, not the judge,
computes) and test-quality signals, then posts that as a native PR review
and label. Everything *around* the model calls is the harness: identity
resolution, fork/draft/closed guards, stale-label clearing, prior-review
reset, and the output wiring a consumer's gate job depends on.

**The pipeline fails closed.** Whenever the review cannot be completed — an
unusable diff or context pack from prep, a floor angle whose workers all
died, an invalid plan after one re-prompt, or the round cap reached while
the judge still wants more work — no verdict is published. `Publish review`
posts an explicit "inconclusive — re-run required" review with the recorded
reason and a `fail` verdict, so a required gate job fails safe and a re-run
recovers it. There is no path from a partial review to a pass.

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
7. **Check out PR head** — full-depth checkout of the PR's head commit, with
   no persisted credentials.
8. **Build diff and context pack** — the deterministic prep step. Resolves
   the base ref and merge-base **in `git`**, then writes
   `.ai-review/diff.patch` and `.ai-review/context-pack.json` (head/base
   SHAs, changed files, churn, and which toolchains are actually present on
   the runner). Nothing downstream re-derives a base ref or probes the
   toolchain — a past incident had a model assert a false premise about the
   repo and hand-pick its own base. If this step fails, the orchestrator
   refuses to start and the run is published as inconclusive.
9. **Resolve linked issues** — deterministically resolves every issue the
   PR closes (closing keywords *and* GitHub's linked-issue graph, via the
   PR's `closingIssuesReferences`) into `.ai-review/linked-issues.json`.
   They are the primary intent contract for the rubric's Angle H. ai-review
   only **reads** linked issues; it never mutates issue state (that is
   `ai-qa`'s post-merge job).
10. **Resolve PR title and body** — written to `.ai-review/pr.json` as a
    file, never an environment variable: a PR body is fully
    attacker-controlled multiline text.
11. **CI signal (re-review only)** — on a `workflow_dispatch` re-review,
    reads the PR's required-check conclusions (`pass`/`fail`/`timeout`/
    `no_ci`) so the Publish step can treat a failing/timed-out required
    check as an automatic fail.
12. **Shadow control arm** *(only when `orchestrator-mode` is `shadow`)* — the
    previous serial pipeline (Haiku context stage → diff-size model route →
    one Sonnet/Opus review call), kept alongside the orchestrator so the two
    can be compared on real PRs. In `shadow` this arm's verdict is the one
    that **governs**, and the orchestrator publishes nothing; in `primary`
    these steps do not run at all.
13. **Review stage (Opus-orchestrated fan-out)** — the orchestrator
    (`orchestrator/index.js`). In order:
    - **Intent brief (Angle H)** — Opus reads the PR title/body and linked
      issues and writes the intent contract **before any code is read**;
      the rubric does not accept a goal re-derived after seeing the diff.
      Docs/config-only diffs are explicitly exempt rather than silently
      skipped.
    - **Collection round** — a small plan of cheap workers gathers the facts
      (call sites, imports, where the tests live) that planning needs.
    - **Round loop**, up to `max-rounds` (default 3). Each round Opus emits a
      plan of at most `max-tasks-per-round` (default 12) tasks and assigns
      each one a model — `haiku-model` for retrieval and mechanical checks,
      `sonnet-model` for judgment about code behaviour. Opus itself
      (`orchestrator-model`) plans and judges but never executes a task. The
      plan is schema-validated: its `scan` tasks must together cover every
      floor angle (A-G), and an invalid plan is re-prompted exactly once
      before the run fails closed. Workers run in parallel, each seeing the
      **whole diff** (a task's focus narrows attention, not visibility, so
      cross-file interactions stay visible), and each must return a
      completion sentinel and the files it actually read — a worker that
      returns neither is a dead worker, not a clean angle. **At most one**
      worker per plan is a `test` task, and it is the only one granted an
      exec allowlist (`test-command`/`test-hint` are rendered into its
      prompt); every other worker is read-only. Opus then judges: it ranks,
      may **refute** a finding it believes is wrong (only with a file and
      line showing why — refuted findings are shown to the PR's humans in a
      collapsed section, not deleted), and decides whether another round is
      needed.
    - **Counts are computed by deterministic code**, from the findings that
      survive dedup and refutation. The judge is not permitted to author
      them; the gate decides on those numbers.
14. **Reset prior review and labels** — dismisses this action's own prior
    `APPROVED`/`CHANGES_REQUESTED` review on the PR (a `COMMENTED` review
    can't be dismissed via the API and is left alone), **collapses every prior
    ai-review review by this bot as `OUTDATED`** (GraphQL `minimizeComment`,
    scoped by the `<!-- ai-review -->` marker so human reviews are never
    touched — non-fatal if the token can't minimize), and removes all four
    labels, so a re-run supersedes cleanly and stale reviews are hidden instead
    of stacking up visibly.
15. **Publish review** — deterministically recomputes the verdict from the
    governing arm's structured output (a `pass` claiming green tests without
    any `verification_evidence` is penalized, not trusted) and posts it as a
    native PR review and the corresponding pass/fail label, then sets the
    four job outputs. When the output is missing or unparseable — every
    fail-closed path — it publishes the inconclusive review described above
    instead of crashing the job. When `update-pr-body` is `true` it also
    **ticks the PR description's checklist boxes** that the review verified
    (`- [ ]` → `- [x]`, never unchecking a human's box) and maintains a
    managed `<!-- ai-review-status -->` block with the per-item verification
    evidence. Editing the body is safe against the default trigger set
    (which excludes `edited`); do **not** add `pull_request: [edited]` to
    the caller or the review will loop on its own body edits.
16. **Pipeline telemetry** — renders per-stage turns, cost, and duration to
    the job summary from the orchestrator's per-stage logs. Pure
    observation: it runs after the verdict is published and touches nothing
    the gate depends on.
17. **Shadow comparison + artifact** *(only in `shadow`)* — a summary table
    of serial vs. orchestrator verdict and counts, plus the orchestrator's
    output/reason/logs uploaded as an artifact. Also pure observation:
    nothing here can cause the orchestrator's output to be published.

## Rollout: shadow vs. primary

`orchestrator-mode` selects which pipeline's verdict governs:

- **`shadow`** (default) — both pipelines run. The **serial** arm's verdict
  is published and gates; the orchestrator publishes nothing and is only
  measured. This is how the orchestrator is validated against a known-good
  baseline before it is trusted.
- **`primary`** — only the orchestrator runs, and its verdict governs. The
  serial arm's steps are skipped entirely.

Shadow mode costs roughly two reviews per PR, so switch to `primary` once
you are satisfied with the comparison.

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
| `anthropic-api-key` | Anthropic API key, sent as `x-api-key`. Mutually exclusive with `anthropic-auth-token` — supply exactly one. | No | — |
| `anthropic-auth-token` | Anthropic bearer token, for gateways that authenticate that way. Mutually exclusive with `anthropic-api-key`. | No | — |
| `anthropic-base-url` | Override for the Anthropic API base URL (e.g. a custom gateway). | No | — |
| `orchestrator-mode` | `shadow` runs both pipelines with the **serial** verdict governing and the orchestrator only measured; `primary` makes the orchestrator the reviewer. See *Rollout* above. | No | `shadow` |
| `orchestrator-model` | Model for Opus's own calls — intent brief, planning, judging. Never assignable to a worker. | No | `claude-opus-5` |
| `sonnet-model` | Model for Sonnet-tier worker tasks (anything needing judgment about code behaviour). | No | `claude-sonnet-5` |
| `haiku-model` | Model for Haiku-tier worker tasks (retrieval and mechanical checks). Also the shadow arm's context stage. | No | `claude-haiku-4-5-20251001` |
| `max-rounds` | Maximum plan/dispatch/judge cycles. Reaching this cap while the judge still wants more work publishes **inconclusive**, never a verdict. | No | `3` |
| `max-tasks-per-round` | Maximum workers dispatched in a single round. | No | `12` |
| `worker-timeout-minutes` | Wall-clock budget for a single model call before it is aborted and recorded as a dead stage. | No | `10` |
| `worker-max-turns` | Maximum agent turns a single model call may take. | No | `60` |
| `test-command` | Explicit command to run the project's tests (e.g. `npm test`). Reaches the single exec-capable `test` worker. **The caller must install the toolchain/deps before this action.** Empty ⇒ the model may auto-detect a command and skips gracefully when no toolchain is present. | No | — |
| `test-hint` | Free-text build/run/verify guidance rendered into the same test worker's prompt (setup steps, which suites matter, known-flaky areas). | No | — |
| `update-pr-body` | When `true`, the Publish step ticks verified checklist boxes in the PR description and maintains a managed `<!-- ai-review-status -->` block. Never unchecks a human-checked box. | No | `true` |
| `update-linked-issues` | When `true`, the linked issues the PR closes are resolved and evaluated. ai-review only reads them; it never mutates issue state. | No | `true` |

Kept for backward compatibility but **inert** — setting them has no effect:
`opus-model` (superseded by `orchestrator-model`), `sonnet-files-threshold`
and `sonnet-churn-threshold` (the diff-size router they fed is gone; each
round's plan sizes itself), and `allowed-bots` (the orchestrator has no
actor check, so bot-authored PRs are reviewed normally).

## Outputs

| Name | Description |
| --- | --- |
| `verdict` | `pass` or `fail`. Empty when the review was skipped (fork PR, draft, or closed) — a consumer's gate should treat empty the same as `fail`. |
| `confidence` | Confidence score, 0-100. |
| `merge_risk` | `low`, `medium`, or `high`. |
| `review_event` | GitHub review event posted: `APPROVE` or `REQUEST_CHANGES`. |

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

Set the calling job's `timeout-minutes` deliberately: composite-action steps
cannot set their own, so it is the only wall-clock backstop around the whole
pipeline. Size it for the pipeline you are running — `shadow` runs both arms
and so costs roughly two reviews' worth of wall clock, and `max-rounds`
bounds how many plan/dispatch/judge cycles the orchestrator may spend.

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
