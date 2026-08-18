# ADR 0004 — Non-blocking findings and structured-output repair

- **Status:** Accepted
- **Date:** 2026-08-03
- **Relates to:** ADR 0001 (gate contract), ADR 0002 (toolchain provisioning
  is the caller's responsibility), ADR 0003 (test execution is best-effort
  and caller-provisioned). All three still hold; this ADR corrects the gate
  arithmetic and the retry path without changing the gate contract.
- **Closes:** issue #25

## Context

### The reported problem was not the actual problem

Issue #25 reported that the deterministic layer forces FAIL when
`test_execution` is `skipped` for want of a toolchain, and asked that
`skipped` be reclassified as neutral.

`test_execution` was read in exactly two places, compared against `"failed"`
and `"passed"`. `"skipped"` was never read and carried no penalty — it was
already neutral, as ADR 0003 §2 intended. The requested change would have been
a no-op.

The evidence in the issue in fact showed something else. On PR
EdulyCom/eduly#3818, three runs on the same commit:

| Time (UTC) | Verdict | Confidence | Merge risk | Implied counts |
|---|---|---|---|---|
| 16:56 | FAIL (override) | 85 | low | p0=0, p1=0, p2=3 |
| 18:20 | FAIL (override) | 85 | low | p0=0, p1=0, p2=3 |
| 22:40 | PASS | 100 | low | p0=0, p1=0, p2=0 |

`merge_risk: low` is only reachable when `p0 === 0 && p1 === 0`, so the failing
runs had no blocking findings at all. `confidence = 100 − 5·p2` put three P2s
at 85, below the default threshold of 90. The **third nice-to-have** hard-failed
the gate — a finding class the rubric itself defines as "can merge with note;
fix in follow-up". Five such override-FAILs appear on that one PR.

Two things made this hard to see. The deterministic override banner stated no
reason, so readers attributed it to whatever the model discussed in
`comment_markdown` — which, on those runs, was the missing test toolchain. And
the arithmetic lived inline in a `github-script` block with no test lane, so no
one could exercise it without paying for a live Opus review.

### The retry was not a retry

On run 30336901616 the review stage ran 332,873 ms / 33 turns / **$3.76** and
ended `is_error: true` with no `structured_output`. The retry fired 11 s later
and returned in **143 ms / 1 turn / $0.00** — it never reached the model. The
completed analysis was discarded and the PR received a bare "inconclusive"
notice. This occurred four times on PR #3818.

## Decision

### 1. P2/P3 findings never block the gate

The pass decision compares a **blocking-finding confidence** — the standard
formula with the P2 term removed — against `confidence-threshold`. The reported
`confidence` output keeps the P2 term so the rubric's calibrated bands and the
merge-risk thresholds stay meaningful. A PASS may therefore display a
confidence below the threshold; that is intended.

P0, P1, a failing/timed-out required CI check, deviated intent, and the
test-quality penalties (`no_tests_for_changed_logic` −15,
`coverage_below_threshold_on_critical_paths` −5, failing tests −10, an
unevidenced `passed` claim −10) all continue to block.

### 2. `test_execution: skipped` stays neutral, and the action still provisions no toolchain

Reaffirmed, and now covered by a regression test. Issue #25's alternative fix —
provisioning Nx/Jest inside the ai-review environment — is **rejected**: ADR
0003 §2 and ADR 0002 place toolchain provisioning on the caller, and the
authoritative test signal is the caller's own CI lanes, not this sandbox.

### 3. Every deterministic FAIL states its reason

`recompute()` returns a `blockers` array naming each condition that fired, and
the Publish step renders it as a "Why the gate failed" line. The banner also
carries the P0-P3 counts, and a PASS with nits says they were non-blocking.

### 4. The gate arithmetic is a tested module

The recomputation moved to `ai-review/lib/recompute.js` — pure, dependency-free
CommonJS, `require()`d by the Publish step via `github.action_path`. A
`node:test` suite in `ai-review/lib/recompute.test.js` runs on every PR via
`.github/workflows/unit.yml` and pins the PR #3818 verdicts as regression cases.

### 5. A missed structured output is repaired, then retried, then salvaged

1. `--resume` the finished session and ask only for the JSON (cheap; the
   analysis already exists).
2. If that misses, sleep 45 s, then run the existing full retry.
3. If that misses too, extract the model's final prose from
   `execution_file` and attach it to the inconclusive review.

### 6. The gate still fails closed

Issue #25's third comment asked for a NEUTRAL verdict on a harness failure. We
keep `fail`. A review that did not complete must not read as a pass, `verdict`
stays a two-value contract every consumer's gate job already understands, and
ADR 0001 (d) lists the verdict computation as not caller-weakenable. The
salvaged prose is the mitigation: the human sees the analysis instead of a bare
re-run notice.

## Consequences

- **Gate contract unchanged.** Same four outputs, same two verdict values.
- **More PRs pass.** Any diff previously failed solely on ≥3 P2 findings now
  passes. This is the intended correction, not a loosening: nothing that the
  rubric defines as blocking has been weakened.
- **Reported confidence can sit below the threshold on a PASS.** Documented in
  the rubric and the banner.
- **Slightly longer worst case.** A run that misses structured output twice now
  costs one extra cheap resume call plus a 45 s sleep. Callers' job-level
  `timeout-minutes` (55 recommended; fan-out regularly exceeds 25m) still bounds it.
- **New CI lane** (`unit.yml`) and the repo's first JavaScript module. No
  `package.json` and no dependencies — `node --test` on the runner's stock Node.
- **`--resume` through `claude_args` is not an explicitly documented
  claude-code-action flow**, though `session_id` is documented as usable with
  it. The step is `continue-on-error` and the full retry still runs if it
  misses, so the worst case is one wasted cheap call.
