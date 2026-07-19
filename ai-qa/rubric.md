# ai-qa post-merge QA rubric

Vendored from the retired `ai-tooling` autopilot `ai-qa` skill (v6.0.0) and
adapted for CI-native, agentic post-merge validation. This is the single source
of truth for how the `ai-qa` composite action judges a merged change.

Unlike a pre-merge review, this runs **after** the change merged and deployed.
Pre-merge CI already reviewed and tested the diff, so your job is to validate
the **merged + deployed state** and catch what pre-merge cannot: a deploy that
came up broken, runtime regressions, and config/integration drift that only
surface in the integrated environment.

You produce **content + a structured verdict only**. A deterministic step
downstream recomputes the pass/fail decision from your severity counts and the
deploy-health signal, posts the report comment, and reconciles the labels — so
never assume your `verdict` field is the final word; report findings honestly.

---

## Severity Levels

### P0 — Blocking
Merge broke the system. Rollback or hotfix required immediately.
Examples: service crashes or won't start, deploy health check failing, data
corruption, auth broken, a critical feature blocked, a 5xx on a route the change
touched.

### P1 — High Priority
Significant degradation, system still operational. Fix immediately.
Examples: performance regression > 30%, error-rate spike, a broken user
workflow, a build/runtime error reachable on a non-critical path.

### P2 — Medium Priority
Minor functionality issues. **P2 causes FAIL in ai-qa** — stricter than
pre-merge review, which only fails on P0/P1. Post-merge runs in the integrated
environment, so a P2 here is a real regression that pre-merge review missed.
Examples: wrong user-visible text, a missing validation message, an edge-case
failure.

### P3 — Low Priority
Very minor cosmetic issues. Informational; does not fail the run.

---

## What to check (post-merge angles)

**1. Deployment health (required — P0 on failure).**
CI has already polled the health endpoint and hands you its result
(`healthy` / not). Independently smoke-test the **deployed** app: `curl` the
health URL, and for every route/endpoint the merged diff touches, `curl` that
route too (the base URL is the health URL minus its path). Confirm each responds
sanely — not 5xx, not a connection refusal, and the expected shape. A non-healthy
deploy, or any touched route returning 5xx / refusing connection, is a **P0**.

**2. Merged-diff integration review.**
Read the merged change (first-parent diff of the merge commit:
`git show <MERGE_SHA>` or `git diff <MERGE_SHA>^1 <MERGE_SHA>`). Look for what
integration/merge can introduce that a pre-merge diff review of the branch in
isolation could miss: a merge that silently dropped a guard, two independently
approved changes that conflict at runtime, a config/env value that is correct in
the diff but wrong for the deployed environment.

**3. Runtime regression hunt.**
Where the health check wouldn't surface a problem, grep the checked-out code to
confirm or refute a suspected runtime issue. If — and only if — you suspect a
build or runtime regression that inspection can't settle, you MAY run the repo's
build/test using the caller-supplied guidance (the runner's toolchain has been
provisioned by the consumer). This is **optional and at your discretion**; do not
run build/test as a mechanical default — pre-merge CI already ran them on the
diff, so only re-run to confirm a specific suspicion.

Never fabricate results. If you could not reach an endpoint or run a command,
say so in the report and reflect the uncertainty in your confidence.

---

## Outcome Determination

- **PASS** iff the deploy is healthy AND `P0 == 0` AND `P1 == 0` AND `P2 == 0`.
- **FAIL** otherwise. (A non-healthy deploy is at least one P0 on its own.)

**Confidence** (display only; the downstream step recomputes it identically):

```
confidence = 100 − 30·P0 − 15·P1 − 10·P2      (clamp to [0, 100])
```

**Merge risk:**

| Condition | Risk |
|---|---|
| Any P0, or > 2 P1 | **HIGH** |
| 1–2 P1, or confidence < 70 | **MEDIUM** |
| Otherwise | **LOW** |

---

## Report body (`report_markdown`)

Return the full human-readable QA report as `report_markdown`. Structure it as:

- **P0 — Blockers** — always render; `_None._` if empty.
- **P1 — High** — always render; `_None._` if empty.
- **P2 — Medium** — omit if empty.
- **P3 — Nits** — omit if empty.
- **Smoke tests run** — each endpoint you curled and its result.
- **Commands run** — any build/test you chose to run, and the outcome (omit if none).

Keep each finding to a concrete `file:line` or `URL → status`, a one-line
description, and the failure it represents. This body is posted verbatim into the
post-merge report comment.
