# `ai-review`

Runs the CI-native AI review gate against a pull request: authors a native
GitHub PR review (`APPROVE` / `REQUEST_CHANGES`) and a pass/fail label, then
exposes the verdict as this action's own outputs
(`verdict`, `confidence`, `merge_risk`, `review_event`) so the calling
workflow can gate its own heavier build/test/deploy jobs on
`verdict == 'pass'`.

**This phase ships a STUBBED verdict.** The `Publish review` step always
posts a hardcoded `pass` / confidence `95` / merge risk `low` / `APPROVE`
result — there is no model call yet. Everything *around* that one block is
the real harness: identity resolution, fork/draft/closed guards, stale-label
clearing, prior-review reset, and the output wiring a consumer's gate job
depends on. The real two-stage AI review pipeline replaces only the stub
block in a later phase; the interface below (inputs and outputs) does not
change when that happens.

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
   PR skips Reset and Publish (logs `skipped — PR is draft or closed`).
7. **Reset prior review and labels** — dismisses this action's own prior
   `APPROVED`/`CHANGES_REQUESTED` review on the PR (a `COMMENTED` review
   can't be dismissed via the API and is left alone) and removes all four
   labels, so a re-run supersedes cleanly instead of stacking reviews.
8. **Publish review** — posts the (stubbed) verdict as a native PR review
   and the corresponding pass/fail label, then sets the four job outputs.

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
| `confidence-threshold` | Minimum confidence (0-100) required for a pass. Declared now as part of the interface; not yet consumed by this stubbed harness. | No | `90` |

## Outputs

| Name | Description |
| --- | --- |
| `verdict` | `pass` or `fail`. Empty when the review was skipped (fork PR, draft, or closed) — a consumer's gate should treat empty the same as `fail`. |
| `confidence` | Confidence score, 0-100. |
| `merge_risk` | `low`, `medium`, or `high`. |
| `review_event` | GitHub review event posted: `APPROVE` or `REQUEST_CHANGES`. |

## Usage

This is the same shape shown in `docs/consumer-integration.md`, section 2a,
using only the inputs this phase actually implements (App credentials are
optional; Anthropic credentials are wired up in a later phase):

```yaml
permissions:
  contents: read
  pull-requests: write

concurrency:
  group: ci-pr-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  ai-review:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    outputs:
      verdict: ${{ steps.review.outputs.verdict }}
    steps:
      - uses: EdulyCom/github-actions/ai-review@main
        id: review
        with:
          app-id: ${{ vars.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}

  review-gate:
    runs-on: ubuntu-latest
    needs: [ai-review]
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

The workflow-level `pull-requests: write` permission is required for
`createReview`/`addLabels`/`dismissReview` to succeed; `contents: read` is
the least-privilege default for the rest of the job.

## Self-test

This repo's own `.github/workflows/selftest.yml` exercises the full path
end to end: it runs `ai-review` on this repo's own PRs and a `gated-demo`
job `needs: [review]` with `if: needs.review.outputs.verdict == 'pass'` —
proving the `verdict` output actually gates a downstream job, not just that
the action runs without error. Since the verdict is currently stubbed to
always pass, `gated-demo` should run on every non-draft, non-fork PR in
this repo; check the `review` job's log for the PR review and label it
posted, and confirm `gated-demo` shows as skipped instead on a draft PR.
A `synchronize` push (a new commit on an existing PR) should show the
stale labels being cleared, the prior review being dismissed, and a fresh
review/label being published — `gated-demo` still runs afterward, since the
stub always resolves to a pass.
