# ADR 0002 — `ai-qa` runs an agentic post-merge review, not a mechanical test command

- **Status:** Accepted
- **Date:** 2026-07-19
- **Supersedes:** the original `ai-qa` behavior described in ADR 0001 (d) — the
  `test-command` mechanism. ADR 0001's gate/identity/injection reasoning still
  holds.

## Context

`ai-qa` runs post-merge on a push to the default branch: it resolves the merged
PR, waits for the deploy to become healthy, and reports a `✓`/`✗ /ai-qa` label
plus a comment. It is informational only — the PR is already merged, so there is
nothing left to gate.

Its original core was a **caller-supplied `test-command`** run via `bash -c`
against the checked-out merge commit (e.g. eduly's
`yarn nx run-many -t build,test`). In practice this added little signal:
pre-merge CI has *already* built and tested that exact diff. Mechanically
re-running the same command post-merge mostly re-derived a result CI already
had, while the genuinely post-merge questions — *did the deploy come up healthy,
does the live app still behave, did integration/merge introduce a runtime
regression?* — went unasked. A failing command also only got a shallow
Haiku "triage summary" bolted on after the fact.

## Decision

Replace the mechanical `test-command` with an **agentic post-merge QA review**.
After the deploy-health poll, Claude (`qa-model`, Sonnet by default) reviews the
**merged + deployed state** against a vendored [`rubric.md`](../../ai-qa/rubric.md)
and returns a schema-validated verdict; a deterministic step recomputes pass/fail
and publishes. Two forks were settled explicitly:

1. **Review scope = full rubric.** The review does all three of: (a) the
   deployment-health gate, (b) an integration/runtime review of the merged diff,
   and (c) live HTTP smoke-testing of the deployed app (the health URL plus any
   routes the diff touches). This is the post-merge complement to `ai-review`'s
   pre-merge diff review — it targets what pre-merge cannot see.

2. **Build/test execution = optional, at Claude's discretion.** There is no
   mandatory command. Claude *may* run the repo's build/tests — guided by an
   optional `test-hint` — but only to confirm a specific suspected regression,
   never as a mechanical default (pre-merge CI already ran them). Consequently
   the action provisions **no toolchain of its own**: the consumer sets up
   Node/etc. in a prior step before invoking `ai-qa`.

### Input surface change

- **Removed:** `test-command`, `haiku-model`.
- **Added:** `test-hint` (optional build/test guidance), `qa-model` (default
  `claude-sonnet-5`), `allowed-tools` (the review's `--allowedTools` allowlist —
  read/grep the code, `curl` the deploy, `git` the diff, optionally a JS/TS
  build/test).
- **Unchanged:** the App-token authoring identity, PR resolution, health poll,
  `pass-label`/`fail-label`, and the Anthropic credential inputs.

## Consequences

- **Still informational, still non-blocking.** No `outputs:`, no Checks API,
  gates nothing — exactly as before. A non-healthy deploy is an automatic P0;
  PASS iff the deploy is healthy **and** P0=P1=P2=0 (P2 fails `ai-qa`, stricter
  than `ai-review`, because a P2 in the integrated environment is a real
  regression pre-merge missed).
- **Verdict is recomputed deterministically**, never taken from the model's own
  `verdict` field — same posture as `ai-review` (ADR 0001 (e)).
- **Injection-safety (ADR 0001 / ADR-0010) preserved.** The attacker-
  influenceable merged diff is read by the model **as a file via `git`**, never
  interpolated into the prompt. Only trusted config (`health-url`,
  `deploy-timeout`, `test-hint`) and the trusted `github.sha` are interpolated
  into the prompt text.
- **Cost/latency rise** versus a single `bash -c`: a Sonnet review with tool use
  costs tokens and wall-clock. Bounded by the job `timeout-minutes` and by the
  review being credential-gated — omit the Anthropic credential and `ai-qa`
  degrades cleanly to the deploy-health signal alone.
- **Consumers must provision their toolchain.** Callers relying on the review's
  optional build/test add a `setup-node` (or equivalent) step before the action.
  eduly's caller does this; the self-test does not (it runs credential-free, so
  the review no-ops and only the health/publish pipeline is exercised).
