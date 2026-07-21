# ADR 0003 — Linked-issue intent, real test execution, and PR/issue write-back

- **Status:** Accepted
- **Date:** 2026-07-21
- **Relates to:** ADR 0001 (gate/identity/injection posture) and ADR 0002
  (`ai-qa` agentic review). Those decisions still hold; this ADR layers new
  capability onto both actions without changing the gate contract.

## Context

`ai-review` (pre-merge) and `ai-qa` (post-merge) each judged a change largely
in isolation: the diff, and — for `ai-qa` — the deploy. Three gaps remained:

1. **Intent was under-specified.** `ai-review`'s rubric (Angle H) asked the
   model to align the diff with the PR's *stated goal*, but the only real
   source was the PR body; the linked issue that actually defines the
   acceptance criteria was never fetched. Worse, the rubric referenced
   `/tmp/main-issue.json` / `/tmp/pr-meta.json` files that **no step ever
   wrote** — dead plumbing.
2. **Test signals were guessed, not run.** `ai-review` reported
   `tests_failing` / `no_tests_for_changed_logic` from *static inspection*;
   its tool allowlist blocked test execution entirely.
3. **Findings were write-only to one comment.** Neither action reflected its
   conclusions back onto the artifacts humans track — the PR description's
   checklist, or the issues the PR closes.

## Decision

### 1. Deterministic linked-issue resolution feeds intent

Both actions gain a bash step that resolves the issues a PR closes — via
closing keywords **and** GitHub's linked-issue graph (`closingIssuesReferences`
GraphQL) — into `.ai-review/linked-issues.json` / `.ai-qa/linked-issues.json`.
The model reads that **file** (never interpolated) and treats each linked
issue's acceptance criteria as the primary intent contract. This retires the
dead `/tmp/*.json` rubric references.

### 2. `ai-review` runs tests best-effort; `ai-qa` verifies the PR test plan

- `ai-review`'s review allowlist now includes the JS/Python/`make` test
  runners; new `test-command` / `test-hint` inputs steer it. It records a
  `test_execution` outcome and, per `/verification-before-completion`, must
  cite the command + output in `verification_evidence` — a `passed` claim with
  no evidence is penalized in the deterministic recompute, not trusted. The
  action provisions **no toolchain**; the caller installs deps first (same
  stance as ADR 0002 for `ai-qa`).
- `ai-qa` extracts the PR body's **Test Plan** section into
  `.ai-qa/test-plan.md` and returns a per-item `test_plan` verdict, exercised
  against the deployed app.

### 3. `/verification-before-completion` joins the live review skills

The review session already loads `/requesting-code-review` from the live
superpowers plugin marketplace. `/verification-before-completion` is loaded the
same way (best-effort; the run never blocks on a missing plugin). We chose the
live-plugin path over vendoring a copy so the discipline never drifts from the
canonical skill.

### 4. Bounded, non-destructive write-back

- **`ai-review` → PR body:** ticks checklist boxes it *verified*
  (`- [ ]` → `- [x]`) and maintains a managed `<!-- ai-review-status -->`
  block. It **never unchecks a human's box**, re-fetches the body immediately
  before writing, and is idempotent. It never mutates issue state.
- **`ai-qa` → issues + PR body:** posts a sticky `<!-- ai-qa-issue -->`
  status comment on each linked issue; on a FAIL it **reopens** an issue the
  merge auto-closed and applies `fail-label` (PASS → `pass-label`); it also
  maintains a `<!-- ai-qa-status -->` block in the PR body.
- Both are gated by `update-pr-body` / `update-linked-issues` (default `true`)
  and are wrapped so any write failure warns without failing the job.

### 5. `ai-review` prefers Opus by default

Diff-size routing is inverted: the review stage now uses `opus-model` for its
stronger reasoning, dropping to `sonnet-model` **only** for trivially tiny
diffs (≤ `sonnet-files-threshold` files **and** ≤ `sonnet-churn-threshold`
churn). Full file contents are always read — never diff hunks alone.

## Consequences

- **Gate contract unchanged.** `ai-review` still exposes the same four outputs
  and `ai-qa` is still informational-only. Verdicts are still recomputed
  deterministically, never taken from the model's self-report.
- **New permission:** `ai-review` callers add `issues: read` (to resolve linked
  issues); `ai-qa` already required `issues: write`, which now also covers the
  linked-issue comments/state changes.
- **Trigger caveat:** because `ai-review` edits the PR body, callers must keep
  the default `pull_request` event types — adding `edited` would loop the
  review on its own body edits.
- **Injection-safety preserved (ADR 0001 / 0002).** All attacker-influenceable
  content — diff, PR body, test plan, linked-issue bodies — is read by the
  model **as files**, staged by bash steps that bind only trusted values via
  `env:`. Nothing PR-author-controlled is interpolated into a prompt.
- **Cost/latency rise** on `ai-review`: Opus-by-default plus real test
  execution costs more tokens and wall-clock than static Sonnet review. Tiny
  diffs still take the cheap Sonnet path, and test execution is best-effort
  (skips cleanly when the caller provisions no toolchain).
- **Context stage is non-fatal.** The Haiku context stage (`context.md`) is a
  best-effort optimization the review reads only "if present", so it now runs
  `continue-on-error`: a flaky Anthropic gateway or plugin-marketplace load
  that hangs/errors that cheap call degrades gracefully instead of sinking the
  whole review. Composite-action steps cannot set `timeout-minutes`, so the
  wall-clock bound on any stage hang is the **caller job's `timeout-minutes`**
  (25 min recommended; the self-test uses 30) — documented in the consumer
  guide. The review + retry stages were already `continue-on-error` with a
  deterministic fail-safe verdict.
