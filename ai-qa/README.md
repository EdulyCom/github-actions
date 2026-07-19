# `ai-qa`

Runs a post-merge, **non-blocking** QA signal after a push to the default
branch: resolves the pull request that was just merged, waits for a
caller-supplied deploy health endpoint to come up, then has **Claude perform a
real agentic post-merge QA review** of the merged and deployed state — smoke-
testing the live app, reviewing the merged diff for integration/runtime risks,
and (only at its own discretion) running the repo's build/tests to confirm a
suspected regression. A deterministic step recomputes a pass/fail verdict from
the review's severity counts and the deploy-health signal, then posts a report
comment and a pass/fail label on the merged PR.

This replaces the earlier design, which mechanically ran a caller-supplied
`test-command`. Post-merge, pre-merge CI has *already* built and tested the
diff, so re-running the same command added little; an agentic review instead
catches what pre-merge cannot — a deploy that came up broken, runtime
regressions, and config/integration drift that only surface in the integrated
environment. See [`rubric.md`](./rubric.md) for the QA rubric the review
follows (severities, deployment gate, verdict rules).

Unlike `ai-review`, this action is purely informational. It has **no
`outputs:` block**, never calls the Checks API, and gates nothing in the
calling workflow — by the time it runs, the PR is already merged, so there is
nothing left to block. It exists to surface "did the thing that just merged
actually come up healthy and behave correctly" as a comment and label, not to
approve or reject anything.

See
[`docs/adr/0001-ci-native-ai-review-gate.md`](../docs/adr/0001-ci-native-ai-review-gate.md)
for the shared reasoning behind why the authoring identity is cosmetic (b),
why this is a composite action consumed via a thin caller workflow rather
than a reusable workflow (c), and the full parameterization surface (d).
Every value bound into a `script:`/`run:` body below is passed via `env:`
and read back from `process.env`/`$VAR` — never interpolated with `${{ }}`
inside the body itself — per this repo's injection-safety rule. (The QA
review step's `prompt:` is a `with:` value fed to the model as prompt text,
not an executable body; the values interpolated into it — `health-url`,
`deploy-timeout`, `test-hint`, and the merge SHA — are trusted
caller-supplied configuration and the trusted `github.sha`, not
PR-author-controlled content. The attacker-influenceable merged diff is read
by the model **as a file via git**, never interpolated into the prompt.)

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
4. **Check out merge commit** — checks out the resolved commit (with
   `fetch-depth: 2`, so the review can diff it against its first parent —
   the change that just merged) with `persist-credentials: false`.
5. **Wait for deploy health** — polls `health-url` with `curl --fail` every
   five seconds until it succeeds or `deploy-timeout` elapses. Unreachable
   at the deadline is treated as an unhealthy deploy (auto-P0 fail signal).
   The result is handed to the review as its starting deployment signal.
6. **Stage QA rubric** — copies the action's own `rubric.md` into the
   workspace so the review can read it with a stable path.
7. **Post-merge QA review (agentic)** — only runs when an Anthropic
   credential is configured. Claude (`qa-model`, Sonnet by default) reads the
   rubric, inspects the merged diff via `git`, **smoke-tests the deployed app
   over HTTP** (the health URL plus any routes the diff touches), and — only
   if it suspects a build/runtime regression inspection can't settle — MAY run
   the repo's build/tests using `test-hint` as guidance. It returns a
   schema-validated structured verdict: per-severity counts (P0–P3),
   confidence, merge risk, a summary, and a full report body. The action
   provisions **no language toolchain of its own** — callers whose review may
   run build/tests must set up Node/etc. in their own workflow *before* this
   action runs.
8. **Publish report** — a deterministic step **recomputes** the pass/fail
   decision from the review's severity counts and the deploy-health signal
   (a non-healthy deploy is an automatic P0; PASS iff deploy healthy AND
   P0=P1=P2=0), never trusting the model's own `verdict`. It posts (or
   updates, via a hidden `<!-- ai-qa -->` anchor, so re-runs don't stack
   duplicate comments) a report comment with the signals, the review summary,
   and the full QA report, then reconciles `pass-label`/`fail-label` on the
   PR. If no Anthropic credential is configured, the review is skipped and the
   report is published from the deploy-health signal alone.

## Inputs

| Name | Description | Required | Default |
| --- | --- | --- | --- |
| `app-id` | GitHub App ID. Optional — with `private-key`, the report comment and label are authored as `<app-slug>[bot]` instead of `github-actions[bot]`. Cosmetic only; see ADR 0001 (b). | No | — |
| `private-key` | GitHub App private key, paired with `app-id`. | No | — |
| `github-token` | Fallback token used when `app-id`/`private-key` are not set, and the token the (unprivileged, read-only) QA review step always uses. | No | `${{ github.token }}` |
| `health-url` | URL polled with `curl --fail` until healthy or `deploy-timeout` elapses; also smoke-tested directly by the review. No sensible generic default exists. | **Yes** | — |
| `deploy-timeout` | Seconds to keep polling `health-url` before giving up. | No | `180` |
| `test-hint` | Optional free-text describing how to build/test this repo. Handed to the review as context — Claude MAY run it at its discretion to confirm a suspected regression, never mechanically. Consumer must provision the toolchain first. | No | `""` |
| `qa-model` | Model used for the agentic QA review. | No | `claude-sonnet-5` |
| `allowed-tools` | Tool allowlist passed to the review's `--allowedTools` (read/grep the code, `curl` the deploy, `git` the diff, optionally run a JS/TS build/test). Override to widen or narrow. | No | *(read/grep/glob + curl/git + node/npm/npx/yarn/pnpm/corepack)* |
| `pass-label` | Label applied when the overall QA signal (health + review) passes. | No | `✓ /ai-qa` |
| `fail-label` | Label applied when the overall QA signal fails. | No | `✗ /ai-qa` |
| `anthropic-api-key` | Anthropic API key for the review step. Optional — without it, the review quietly no-ops and the report still publishes from the deploy-health signal alone. | No | — |
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
`health-url` is inherently per-repo and has no sensible generic default — set
it to a real value for your deployment. Anthropic credentials are optional;
omit them and `ai-qa` still reports the deploy-health signal, just without an
agentic review.

Because the review may (at its discretion) run the repo's build/tests, the
consumer provisions the toolchain in a prior step — the action ships none of
its own. Pass `test-hint` so the review knows this repo's build/test command.

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
          app-id: ${{ vars.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
          anthropic-auth-token: ${{ secrets.ANTHROPIC_AUTH_TOKEN }}
          health-url: https://your-deployed-environment.example.com/health
          test-hint: "yarn nx run-many -t build,test"
```

`issues: write` is required (in addition to `pull-requests: write`) because
the report comment and label both go through the Issues API — the PR is
already merged and closed by the time this runs, so a formal
`pulls.createReview` (what `ai-review` uses) isn't applicable here; a plain
issue comment is.

## Self-test

`.github/workflows/ai-qa-selftest.yml` runs this action against every push
to this repo's own `main` — i.e. every PR merged here exercises `ai-qa` for
real, against the actual merge commit `github.sha` resolves to. It uses a
deliberately trivial happy-path config (`health-url` pointing at this
repo's own raw `README.md`) purely to prove the report/label pipeline end to
end; it is not a substitute for testing a real deploy-health endpoint with a
real agentic review.

To exercise the failure path (a deliberately broken or unreachable
health-url timing out rather than hanging the job) or the sticky-comment
update-in-place behavior on a repeat merge commit, run the checks
`ai-review`'s self-test performs against a consumer repo with a real
deployment: merge a PR and confirm (a) the report comment appears and updates
in place on a re-run against the same merge commit rather than duplicating,
(b) `pass-label`/`fail-label` reconcile correctly for both an outright pass
and a deliberately broken health-url, and (c) an unreachable health-url still
produces a report once `deploy-timeout` elapses.
