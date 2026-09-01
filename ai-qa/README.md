# `ai-qa`

**Delivery hygiene** after a change is merged (or a PR/issue is closed) —
not a second code review. Pre-merge CI and `ai-review` already judged the
diff. GitHub treats merge as "done" (auto-close issues, optionally delete
the head branch); this action owns the actual done signal:

- **PR-level.** Merged: poll `health-url`, optionally run an agentic QA
  review, then on **PASS** delete the head branch; on **FAIL** keep it.
  Closed without merge: delete the head branch (GitHub never does this).
  Never deletes the default branch, a fork head, or a ref still used by
  another open PR.
- **Issue-level.** On delivery **PASS**, **close** linked issues (turn off
  GitHub auto-close-on-merge so merge is not "done"). On **FAIL**, leave
  them open (reopen if GitHub already auto-closed them). On `issues.closed`,
  reopen an issue closed before delivery was verified, unless this action
  closed it or it is `not_planned`.

An optional Claude review can still smoke-test the live app and evaluate a
PR Test Plan; it is color on the report, not the reason this action exists.
A deterministic step recomputes pass/fail from severity counts and deploy
health, then posts a report comment and labels. See [`rubric.md`](./rubric.md)
for the optional review rubric.

Unlike `ai-review`, this action is purely informational. It has **no
`outputs:` block**, never calls the Checks API, and gates nothing in the
calling workflow.

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
PR-author-controlled content. The attacker-influenceable merged diff — and,
new in this version, the PR body, its Test Plan section, and linked-issue
bodies — are all read by the model **as files** (`.ai-qa/pr-meta.json`,
`.ai-qa/test-plan.md`, `.ai-qa/linked-issues.json`, staged by a bash step
that binds only trusted values via `env:`), never interpolated into the
prompt.)

## What each run does

1. **Author token** — if `app-id` and `private-key` are both set, mints a
   job-scoped GitHub App installation token limited to
   `pull-requests: write` and `issues: write` (never the installation's
   full permission set). Otherwise falls through to `github-token`.
2. **Resolve author identity** — settles on one token and one identity
   string (`<app-slug>[bot]` or `github-actions[bot]`) reused by every
   later step.
3. **Route event** — `push` and `pull_request` closed+merged take the
   delivery path; closed-without-merge only cleans the head branch;
   `issues.closed` takes the premature-reopen path (PRs that fire as
   issues are skipped).
4. **Resolve merged PR and merge commit** — on `push`, looks up the pull
   request(s) associated with `github.sha` via
   `GET /repos/{owner}/{repo}/commits/{sha}/pulls` (works across merge,
   squash, and rebase) and picks the most recently merged one. On
   `pull_request` closed+merged, uses the event's PR number and merge
   commit. If none is found, remaining delivery steps are skipped with a
   `::notice::`.
4. **Check out merge commit** — checks out the resolved commit (with
   `fetch-depth: 2`, so the review can diff it against its first parent —
   the change that just merged) with `persist-credentials: false`.
5. **Resolve PR context and linked issues** — writes the merged PR's
   metadata (`.ai-qa/pr-meta.json`), its extracted **Test Plan** section
   (`.ai-qa/test-plan.md`, empty when the PR had none), and the issues the
   PR closed (`.ai-qa/linked-issues.json`, resolved via closing keywords
   *and* GitHub's linked-issue graph) into the workspace for the review and
   publish steps. Best-effort — any lookup failure degrades to an empty
   artifact.
6. **Wait for deploy health** — polls `health-url` with `curl --fail` every
   five seconds until it succeeds or `deploy-timeout` elapses. Unreachable
   at the deadline is treated as an unhealthy deploy (auto-P0 fail signal).
   The result is handed to the review as its starting deployment signal.
7. **Stage QA rubric** — copies the action's own `rubric.md` into the
   workspace so the review can read it with a stable path.
8. **Post-merge QA review (agentic)** — only runs when an Anthropic
   credential is configured. Claude (locked Sonnet primary with
   Cursor → free fallbacks) reads the
   rubric, inspects the merged diff via `git`, **smoke-tests the deployed app
   over HTTP** (the health URL plus any routes the diff touches), **evaluates
   the PR's Test Plan** if one is present (running each item it can against
   the deployed app and returning a per-item `test_plan` verdict), and — only
   if it suspects a build/runtime regression inspection can't settle — MAY run
   the repo's build/tests using `test-hint` as guidance. It returns a
   schema-validated structured verdict: per-severity counts (P0–P3),
   confidence, merge risk, a summary, the `test_plan` object, and a full
   report body. The action provisions **no language toolchain of its own** —
   callers whose review may run build/tests must set up Node/etc. in their own
   workflow *before* this action runs.
9. **Publish report** — a deterministic step **recomputes** the pass/fail
   decision from the review's severity counts and the deploy-health signal
   (a non-healthy deploy is an automatic P0; PASS iff deploy healthy AND
   P0=P1=P2=0), never trusting the model's own `verdict`. It posts (or
   updates, via a hidden `<!-- ai-qa -->` anchor) a report comment and
   reconciles `pass-label`/`fail-label` on the PR. When
   `update-linked-issues` is `true` it posts a sticky QA-status comment on
   each linked issue; on **PASS** it **closes** the issue (delivery is done)
   and applies `pass-label`; on **FAIL** it leaves the issue open (and
   reopens it if GitHub already auto-closed it) and applies `fail-label`.
   When `cleanup-head-branch` is `true` and delivery PASSed, it deletes the
   PR head branch. When `update-pr-body` is `true` it maintains a managed
   `<!-- ai-qa-status -->` block in the PR description. If no Anthropic
   credential is configured, the review is skipped and the report is
   published from the deploy-health signal alone.
10. **Closed-without-merge / premature issue-close** — a `pull_request`
    closed event that was not merged only deletes the head branch. An
    `issues.closed` event reopens the issue if it was closed before delivery
    (linked merged PR without `✓ /ai-qa`), unless this action closed it.

## Inputs

| Name | Description | Required | Default |
| --- | --- | --- | --- |
| `app-id` | GitHub App ID. Optional — with `private-key`, the report comment and label are authored as `<app-slug>[bot]` instead of `github-actions[bot]`. Cosmetic only; see ADR 0001 (b). | No | — |
| `private-key` | GitHub App private key, paired with `app-id`. | No | — |
| `github-token` | Fallback token used when `app-id`/`private-key` are not set, and the token the (unprivileged, read-only) QA review step always uses. | No | `${{ github.token }}` |
| `health-url` | URL polled with `curl --fail` until healthy or `deploy-timeout` elapses; also smoke-tested directly by the review. No sensible generic default exists. | **Yes** | — |
| `deploy-timeout` | Seconds to keep polling `health-url` before giving up. | No | `180` |
| `test-hint` | Optional free-text describing how to build/test this repo. Handed to the review as context — Claude MAY run it at its discretion to confirm a suspected regression, never mechanically. Consumer must provision the toolchain first. | No | `""` |
| `allowed-tools` | Tool allowlist passed to the review's `--allowedTools` (read/grep the code, `curl` the deploy, `git` the diff, optionally run a JS/TS build/test). Override to widen or narrow. | No | *(read/grep/glob + curl/git + node/npm/npx/yarn/pnpm/corepack)* |
| `pass-label` | Label applied when the overall QA signal (health + review) passes. Also applied to linked issues when `update-linked-issues` is on. | No | `✓ /ai-qa` |
| `fail-label` | Label applied when the overall QA signal fails. Also applied to linked issues when `update-linked-issues` is on. | No | `✗ /ai-qa` |
| `update-pr-body` | When `true`, the Publish step maintains a managed `<!-- ai-qa-status -->` block in the merged PR's description reflecting the latest QA status. | No | `true` |
| `update-linked-issues` | When `true`, posts a sticky QA-status comment on each linked issue; on PASS **closes** the issue and applies `pass-label`; on FAIL leaves it open (reopens if GitHub auto-closed it) and applies `fail-label`. | No | `true` |
| `cleanup-head-branch` | When `true`, delete the PR head after a delivery PASS, or immediately on close-without-merge. Requires `contents: write` on `GITHUB_TOKEN`. | No | `true` |
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
  pull_request:
    types: [closed]
  issues:
    types: [closed]

permissions:
  contents: write   # delete head branch (GITHUB_TOKEN); 403 degrades to a warning
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

Turn **off** GitHub auto-close (Settings → General → Issues → "Auto-close
issues with merged linked pull requests") so merge is not treated as done;
this action closes linked issues only after delivery PASS.

`issues: write` is required because comments, labels, close, and reopen go
through the Issues API. `contents: write` is required to delete the head
branch via `GITHUB_TOKEN` (the App author token is not granted Contents).

## Self-test

`.github/workflows/ai-qa-selftest.yml` runs this action on push to `main`,
`pull_request` closed, and `issues` closed. The merge path uses a trivial
`health-url` (this repo's raw `README.md`) so the report/label/close/cleanup
pipeline is exercised without a real deploy.

To exercise the failure path (a deliberately broken or unreachable
health-url timing out rather than hanging the job) or the sticky-comment
update-in-place behavior on a repeat merge commit, run the checks
`ai-review`'s self-test performs against a consumer repo with a real
deployment: merge a PR and confirm (a) the report comment appears and updates
in place on a re-run against the same merge commit rather than duplicating,
(b) `pass-label`/`fail-label` reconcile correctly for both an outright pass
and a deliberately broken health-url, and (c) an unreachable health-url still
produces a report once `deploy-timeout` elapses.
