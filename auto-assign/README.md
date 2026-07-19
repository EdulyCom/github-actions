# `auto-assign`

Assigns a pull request's author as its own assignee. This keeps "who owns this
PR" visible in the GitHub UI without requiring anyone to remember to click
"assign myself."

The action skips assigning when any is true:

- there is no `pull_request` context in the triggering event (e.g. a
  `workflow_dispatch` run — the action no-ops rather than failing), or
- the PR author's login ends in `[bot]` (e.g. a Dependabot or Renovate PR), or
- the PR already has one or more assignees.

It calls `github.rest.issues.addAssignees` via a single
[`actions/github-script`](https://github.com/actions/github-script) step,
pinned to a full commit SHA per this repo's supply-chain policy (see
[`docs/adr/0001-ci-native-ai-review-gate.md`](../docs/adr/0001-ci-native-ai-review-gate.md),
section (f)). The PR author and PR number are bound into the step via
`env:` and read from `process.env` inside the script, rather than
interpolated with `${{ }}` — the same injection-safety rule this repo's
other actions follow, so an attacker-controlled PR author login or title
can never be spliced into code-like context.

## Inputs

| Name | Description | Required | Default |
| --- | --- | --- | --- |
| `app-id` | GitHub App ID. Optional — with `private-key`, the assignment is authored as `<app-slug>[bot]` instead of `github-actions[bot]`. Cosmetic only. | No | — |
| `private-key` | GitHub App private key, paired with `app-id`. | No | — |
| `github-token` | Fallback token used when `app-id`/`private-key` are not set. Override only if you need a different identity or scope. | No | `${{ github.token }}` |

## Usage

**Preferred — inline it as the first step of the `ai-review` job**, before the
review runs, so a repo needs one fewer workflow file and the assignment is
authored by the same App identity as the review. The action no-ops on the
`workflow_dispatch` (manual re-review) path, so no event guard is needed:

```yaml
jobs:
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
          # ...ai-review inputs...
```

**Standalone** — the action also works as its own `on: pull_request` workflow
if you'd rather not couple it to `ai-review`:

```yaml
name: auto-assign

on:
  pull_request:
    types: [opened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  auto-assign:
    runs-on: ${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}
    steps:
      - uses: EdulyCom/github-actions/auto-assign@main
        with:
          app-id: ${{ vars.MTM_BOT_APP_ID }}
          private-key: ${{ secrets.MTM_BOT_APP_PRIVATE_KEY }}
```

Passing `app-id`/`private-key` is optional. Without them the action falls back
to the calling workflow's `GITHUB_TOKEN` and authors the assignment as
`github-actions[bot]`. Either way the job needs `pull-requests: write` (the
App token minted from `app-id`/`private-key` carries its own scope; the
`GITHUB_TOKEN` fallback relies on the job/workflow permission).

## Self-test

To confirm this action behaves as intended in a consuming repo, open a PR
from a non-bot account with no assignee set: the action should assign the
PR's author. Opening a PR from a `dependabot[bot]`-style account, or a PR
that already has an assignee, should leave assignees unchanged — check the
step log for the corresponding "skipping" message.
