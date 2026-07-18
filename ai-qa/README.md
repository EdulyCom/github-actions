# `ai-qa`

Runs a post-merge, **non-blocking** QA signal after a push to the default
branch: resolves the pull request that was just merged, polls a
caller-supplied deploy health endpoint, runs a caller-supplied test command
against the merged commit, optionally has Claude triage a failing outcome
into a short summary, then posts a report comment and a pass/fail label on
the merged PR.

Unlike `ai-review`, this action is purely informational. It has **no
`outputs:` block**, never calls the Checks API, and gates nothing in the
calling workflow — by the time it runs, the PR is already merged, so there
is nothing left to block. It exists to surface "did the thing that just
merged actually come up healthy and pass its tests" as a comment and label,
not to approve or reject anything.

See
[`docs/adr/0001-ci-native-ai-review-gate.md`](../docs/adr/0001-ci-native-ai-review-gate.md)
for the shared reasoning behind why the authoring identity is cosmetic (b),
why this is a composite action consumed via a thin caller workflow rather
than a reusable workflow (c), and the full parameterization surface (d).
Every value bound into a `script:`/`run:` body below is passed via `env:`
and read back from `process.env`/`$VAR` — never interpolated with `${{ }}`
inside the body itself — per this repo's injection-safety rule. (The one
exception is the triage step's `prompt:` input, which is a `with:` value
fed to the model as prompt text, not an executable body — the values
interpolated into it, `health-url` and `deploy-timeout`, are trusted
caller-supplied configuration, not PR-author-controlled content.)

## What each run does

1. **Author token** — if `app-id` and `private-key` are both set, mints a
   job-scoped GitHub App installation token limited to
   `pull-requests: write` and `issues: write` (never the installation's
   full permission set). Otherwise falls through to `github-token`.
2. **Resolve author identity** — settles on one token and one identity
   string (`<app-slug>[bot]` or `github-actions[bot]`) reused by every
   later step.
3. **Resolve merged PR and merge commit** — looks up the pull request(s)
   associated with the pushed commit (`github.sha`) via
   `GET /repos/{owner}/{repo}/commits/{sha}/pulls`, which correctly
   resolves the source PR across merge, squash, and rebase strategies, and
   picks the most recently merged one. If none is found (e.g. a direct
   push straight to the default branch), every remaining step is skipped
   with a `::notice::` — non-blocking by design, nothing to report against.
4. **Check out merge commit** — checks out the resolved commit so
   `test-command` runs against the exact code that was merged.
5. **Wait for deploy health** — polls `health-url` with `curl --fail` every
   five seconds until it succeeds or `deploy-timeout` elapses. Unreachable
   at the deadline is treated as an unhealthy deploy (fail signal).
6. **Run test command** — runs `test-command` via `bash -c`, capturing its
   exit code and full output (`test-output.log`) regardless of the health
   check's outcome, since a failing deploy and a failing test are distinct,
   independently useful signals.
7. **Triage failing logs (Haiku)** — only runs when the health check or
   test command failed **and** an Anthropic credential is configured.
   Reads `test-output.log` and writes a short, schema-validated
   plain-language summary (what failed, likely root cause, one next step).
   Summary only — it never attempts a fix or a code-quality judgment.
8. **Publish report** — posts (or updates, via a hidden `<!-- ai-qa -->`
   anchor, so re-runs don't stack duplicate comments) a report comment
   showing the health/test signals, the triage summary if one was
   produced, and a tail of the test output, then reconciles `pass-label`/
   `fail-label` on the PR.

## Inputs

| Name | Description | Required | Default |
| --- | --- | --- | --- |
| `app-id` | GitHub App ID. Optional — with `private-key`, the report comment and label are authored as `<app-slug>[bot]` instead of `github-actions[bot]`. Cosmetic only; see ADR 0001 (b). | No | — |
| `private-key` | GitHub App private key, paired with `app-id`. | No | — |
| `github-token` | Fallback token used when `app-id`/`private-key` are not set, and the token the (unprivileged, read-only) triage step always uses. | No | `${{ github.token }}` |
| `health-url` | URL polled with `curl --fail` until healthy or `deploy-timeout` elapses. No sensible generic default exists. | **Yes** | — |
| `deploy-timeout` | Seconds to keep polling `health-url` before giving up. | No | `180` |
| `test-command` | Shell command run via `bash -c` against the checked-out merge commit; its exit code is the test pass/fail signal. No sensible generic default exists. | **Yes** | — |
| `pass-label` | Label applied when the overall QA signal (health + test) passes. | No | `✓ /ai-qa` |
| `fail-label` | Label applied when the overall QA signal fails. | No | `✗ /ai-qa` |
| `haiku-model` | Model used by the optional triage step. Only ever invoked on failure, and only with a credential configured. | No | `claude-haiku-4-5-20251001` |
| `anthropic-api-key` | Anthropic API key for the triage step. Optional — without it, triage quietly no-ops and the report still publishes from the health/test signals alone. | No | — |
| `anthropic-auth-token` | Bearer token for a custom Anthropic-compatible gateway, used instead of `anthropic-api-key`. | No | — |
| `anthropic-base-url` | Optional custom Anthropic-compatible API base URL. | No | — |

`pass-label`/`fail-label` default to the exact same label text
(`✓ /ai-qa` / `✗ /ai-qa`) that `ai-review` already knows how to clear from
a PR on its own re-runs — don't override one without the other, or the two
actions' label bookkeeping will drift apart.

## Outputs

None. This action is informational only — see the note at the top of this
file for why there's nothing to gate on.

## Usage

This is the same shape shown in `docs/consumer-integration.md`, section 2c.
`health-url` and `test-command` are inherently per-repo and have no
sensible generic default — set both to real values for your deployment.
Anthropic credentials are optional; omit them and `ai-qa` still reports the
health/test signal, just without a triage summary on failure.

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
    timeout-minutes: 15
    steps:
      - uses: EdulyCom/github-actions/ai-qa@main
        with:
          app-id: ${{ vars.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
          anthropic-auth-token: ${{ secrets.ANTHROPIC_AUTH_TOKEN }}
          health-url: https://your-deployed-environment.example.com/health
          test-command: "npm run smoke-test"
```

`issues: write` is required (in addition to `pull-requests: write`) because
the report comment and label both go through the Issues API — the PR is
already merged and closed by the time this runs, so a formal
`pulls.createReview` (what `ai-review` uses) isn't applicable here; a plain
issue comment is.

## Self-test

There is no live consumer wired up for `ai-qa` yet — a later task adds one.
Until then, this action can't be exercised end to end against a real merge;
validation for this task was limited to static checks (YAML parses, every
third-party `uses:` is a full-length SHA, no `${{ }}` inside a `run:`/
`script:` body). Once a consumer is wired up, the same checks
`ai-review`'s self-test performs apply here: merge a PR into a repo running
this action and confirm (a) the report comment appears (and updates in
place on a re-run against the same merge commit, rather than duplicating),
(b) `pass-label`/`fail-label` reconcile correctly for both an outright pass
and a deliberately broken health-url/test-command, and (c) an unreachable
health-url still produces a report (timeout, not a hung job) once
`deploy-timeout` elapses.
