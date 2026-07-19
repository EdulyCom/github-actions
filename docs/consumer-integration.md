# Consumer integration guide

This guide is for a repository that wants to adopt the actions in
`EdulyCom/github-actions`. It is written generically — no step here assumes
you are EdulyCom. Wherever an EdulyCom-specific value would appear, this
guide names the generic secret/variable a caller supplies instead.

See `docs/adr/0001-ci-native-ai-review-gate.md` for the reasoning behind the
shape described here (why the gate is a job output rather than a Check Run,
why the authoring identity is cosmetic, why these are composite actions
consumed via a thin caller rather than reusable workflows).

## 1. Secrets and variables to set

Set these in your repository's (or organization's) Actions secrets/variables
before wiring up the caller workflows below. Names here are illustrative —
use whatever names your own workflows reference, as long as they're passed
through to the `with:` inputs shown in section 2.

| Kind | Purpose | Required? |
| --- | --- | --- |
| Secret: App private key (e.g. `APP_PRIVATE_KEY`) | Pairs with an App ID to author reviews and labels under your own GitHub App's identity instead of `github-actions[bot]`. Purely cosmetic — see ADR 0001 (b). | Optional |
| Variable: App ID (e.g. `APP_ID`) | Paired with the private key above. | Optional, required if using the private key |
| Secret: Anthropic credential (`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, depending on which your endpoint expects) | Authenticates the model calls the review/QA actions make. | Required for `ai-review`; optional for `ai-qa` (only gates its failure-triage summary — the health/test signal and report post regardless) |
| Variable: custom base URL (e.g. `ANTHROPIC_BASE_URL`) | Only needed if you route through a gateway or proxy instead of the standard Anthropic API endpoint. | Optional |
| Variable: runner label (e.g. `RUNNER_LABEL`) | Overrides the default `ubuntu-latest` runner if your org uses self-hosted or labeled runners. | Optional |

Nothing above is invented by this repo — every one of these is a caller
input with a generic fallback where a fallback makes sense (see ADR 0001
(d) for the full parameterization surface). If you omit the App
credentials, reviews and labels are simply authored as `github-actions[bot]`
instead of your App's slug; nothing else changes.

## 2. Caller workflows to copy

Copy the three workflows below into your repo and adjust only the inputs
called out inline. Each one is intentionally small — the actions themselves
own the step logic; these own your triggers, permissions, and concurrency
(see ADR 0001 (c) for why that split exists).

### 2a. AI review, wired into your own CI

Add this as the *first* job in your existing `ci.yml` (or a comparable
workflow), then make every heavy job in that same workflow `needs:` the
`review-gate` job below it — do not create a separate `ai-review.yml`
workflow, since the point of the composite-action shape is that this job
lives inside your own CI's job graph and shares its concurrency group:

```yaml
# In your existing ci.yml, alongside your other jobs:

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: ci-pr-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  ai-review:
    runs-on: ${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}
    timeout-minutes: 15
    outputs:
      verdict: ${{ steps.review.outputs.verdict }}
    steps:
      - uses: EdulyCom/github-actions/ai-review@main
        id: review
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          anthropic-base-url: ${{ vars.ANTHROPIC_BASE_URL }}
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

  # Your existing heavy jobs, e.g.:
  build:
    needs: [review-gate]
    runs-on: ubuntu-latest
    steps:
      - run: echo "build steps go here"
```

Then, in branch protection, require the `review-gate` job's status (and
your terminal CI job, e.g. `build`) as required status checks. If this repo
previously required an old identity-pinned check (for example a
`quality-gate` or `ai-review` App-authored Check Run) as a required status
context, **that old context must be removed** once `review-gate` is wired
in and confirmed posting — otherwise every PR deadlocks on a check that
nothing will ever post to again. Add the new required context first,
confirm it's green on a real PR, and only then remove the old one, so there
is never a window where neither gate is enforced.

### 2b. Auto-assign — inline it in the `ai-review` job

**Preferred:** add `auto-assign` as the first step of the `ai-review` job
(before the review step), rather than as a separate workflow file. It needs one
fewer file, and passing the same `app-id`/`private-key` authors the assignment
under the App identity. The action no-ops on the `workflow_dispatch` path (no
`pull_request` context), so no extra event guard is needed:

```yaml
  ai-review:
    name: 🤖 AI Review
    if: github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch'
    runs-on: ${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}
    permissions:
      contents: read
      pull-requests: write
    outputs:
      verdict: ${{ steps.review.outputs.verdict }}
    steps:
      - name: Auto-assign PR author
        uses: EdulyCom/github-actions/auto-assign@main
        with:
          app-id: ${{ vars.MTM_BOT_APP_ID }}
          private-key: ${{ secrets.MTM_BOT_APP_PRIVATE_KEY }}
      - id: review
        uses: EdulyCom/github-actions/ai-review@main
        with:
          # ...ai-review inputs (section 2a)...
```

A standalone `on: pull_request` `auto-assign.yml` still works if you prefer to
keep it decoupled — see [`auto-assign/README.md`](../auto-assign/README.md).

### 2c. `ai-qa.yml`

Runs after a merge, as a non-blocking signal against your deployed
environment — it does not gate anything and does not need a `review-gate`
style job. Post-merge, Claude performs an agentic QA review: it smoke-tests
the deployed app, reviews the merged diff for integration/runtime risks, and
(only at its discretion) may run your build/tests to confirm a suspected
regression. Provision any toolchain that review might need *before* the
action — it ships none of its own:

```yaml
name: ai-qa

on:
  push:
    branches: [main]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  ai-qa:
    runs-on: ${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}
    timeout-minutes: 20
    steps:
      # The action provisions no toolchain of its own — set up whatever the
      # QA review might need to run build/tests, before invoking it.
      - uses: actions/setup-node@v6
        with:
          node-version: '24'
      - uses: EdulyCom/github-actions/ai-qa@main
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          anthropic-base-url: ${{ vars.ANTHROPIC_BASE_URL }}
          health-url: https://your-deployed-environment.example.com/health
          test-hint: "npm run build && npm test"
```

`health-url` is inherently per-repo and has no sensible generic default — you
must set it to a real value for your deployment. `test-hint` is optional
free-text guidance describing how to build/test this repo; the review runs it
only if it decides to (it is not a mechanical command), so it need not be
exhaustive. Unlike `ai-review`, the report `ai-qa` posts is a plain PR
comment (the PR is already merged and closed by the time this runs, so a
formal `pulls.createReview` isn't applicable) plus a `✓`/`✗ /ai-qa` label —
both go through the Issues API, hence `issues: write` above in addition to
`pull-requests: write`. The Anthropic credential is optional here (see
section 1) — omit it and `ai-qa` still reports the deploy-health signal, just
without the agentic review.

## 3. Cutting over from an old identity-pinned check

If your repo previously used an App-authored, identity-pinned enforcing
Check Run as its AI-review gate (the design ADR 0001 replaces), cutover is
a two-step branch-protection change, not a one-line swap:

1. Add `review-gate` (and any new terminal CI job name) as a required
   status check, **alongside** the old required context, and merge a PR
   that exercises the new caller workflow end to end so you can confirm the
   new context posts correctly.
2. Only after confirming the new context is green, remove the old
   identity-pinned context from the required list. Leaving it in place
   after cutover will block every future PR, since nothing posts to that
   context anymore once the old server-based workflow is retired.
