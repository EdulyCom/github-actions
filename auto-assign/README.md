# `auto-assign`

Assigns a pull request's author as its own assignee when the PR is opened or
marked ready for review. This keeps "who owns this PR" visible in the GitHub
UI without requiring anyone to remember to click "assign myself."

The action skips assigning when either is true:

- the PR author's login ends in `[bot]` (e.g. a Dependabot or Renovate PR),
  or
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
| `github-token` | Token used to call the GitHub REST API to add the assignee. Override only if you need a different identity or scope (e.g. an App installation token). | No | `${{ github.token }}` |

## Usage

Add a workflow like this to the consuming repo (this is the same example
shown in `docs/consumer-integration.md`, section 2b):

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
    runs-on: ubuntu-latest
    steps:
      - uses: EdulyCom/github-actions/auto-assign@main
```

No `with:` inputs are required — the default `github-token` is sufficient
for the standard case of assigning within the same repo the PR was opened
against. The workflow-level `pull-requests: write` permission is required
for `addAssignees` to succeed; `contents: read` is the least-privilege
default for the rest of the job.

## Self-test

To confirm this action behaves as intended in a consuming repo, open a PR
from a non-bot account with no assignee set: the action should assign the
PR's author within the `auto-assign` job's run. Opening a PR from a
`dependabot[bot]`-style account, or a PR that already has an assignee,
should leave assignees unchanged — check the job log for the corresponding
"skipping auto-assign" message.
