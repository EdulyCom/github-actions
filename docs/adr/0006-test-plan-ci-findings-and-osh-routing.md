# ADR 0006 — Test Plan ↔ CI findings, delta reviews, and roster-K OSH routing

- **Status:** Accepted
- **Date:** 2026-08-17
- **Relates to:** ADR 0001 (gate contract — unchanged), ADR 0003 (partially
  supersedes §4 `ai-review` checklist write-back and §5 size-based Opus routing),
  ADR 0005 (roster / aggregation prerequisites). Implements
  `docs/superpowers/specs/2026-08-17-ai-review-osh-delta-testplan-design.md`.

## Context

ADR 0003 taught `ai-review` to tick PR-description checklist boxes it marked
verified and to prefer Opus except on trivially tiny diffs
(`sonnet-files-threshold` / `sonnet-churn-threshold`). Both choices aged poorly:

1. **Checklist ticks were dishonest.** The review does not execute the Test
   Plan. Ticking boxes implied human-visible “verified” when the signal was
   model judgment, not CI. Consumers also had to avoid `pull_request: edited`
   to prevent write-back loops.
2. **Size-based Sonnet/Opus routing fought the roster.** Parallel OSH work
   already packs coverage into K bins (`assignments.json`). Diff file/churn
   thresholds selected the wrong axis once an Opus parent fans out Sonnet
   workers for K>1 and collapses to a single Sonnet session at K≤1.

Design slices on this branch also add **delta reviews** (re-runs review only
commits after the last published `<!-- ai-review -->` meta unless forced full).

## Decision

### 1. Retire `ai-review` checklist tick / status-block write-back

Publish no longer ticks `- [ ]` → `- [x]` in the PR body and no longer maintains
an `<!-- ai-review-status -->` block. Input `update-pr-body` stays accepted for
compatibility and is a **no-op** on that path.

`ai-qa`'s managed PR-body / linked-issue write-back is unchanged.

### 2. Test Plan gaps become ordinary findings vs CI

Prep stages `.ai-review/test-plan-items.json` (Test Plan section and/or
checkboxes) and `.ai-review/ci-checks.json` (check runs for the PR HEAD). The
review maps items to CI coverage; uncovered or weakly covered items are normal
`findings[]` (P0–P3 via the rubric and `recompute.js`). The schema `checklist`
field stays empty. `test_execution` remains `"skipped"` — no test runners in the
allowlist (see also the later retirement of in-review test execution documented
in `ai-review/README.md`).

### 3. Route the review session by roster K, not diff size

| K | Mode | Review session |
| --- | --- | --- |
| ≤1 (incl. empty-diff `0`) | `collapse` | Single Sonnet + `--json-schema` |
| >1 (max 4) | `fanout` | Opus parent + Sonnet Task workers (`osh-*` agents); only Opus emits structured output |

`sonnet-files-threshold` / `sonnet-churn-threshold` remain accepted but are
**deprecated for model routing**.

### 4. Delta reviews with an explicit full-review escape hatch

On re-runs, prep prefers the range after the prior published review’s
`head_sha` when ancestry and merge-base allow. Full merge-base…HEAD is used on
first run, missing/inconclusive meta, force-push, base change, or
`force-full-review: true`.

## Consequences

- **Gate contract unchanged.** The four job outputs and deterministic recompute
  still decide pass/fail; Publish still posts a native review + labels.
- **Honest Test Plan signal.** Gaps show up as findings against CI, not as
  checked boxes in the description.
- **No `edited`-loop caveat for `ai-review`.** Body write-back from this action
  is gone; callers no longer need that warning for checklist ticks (they may
  still avoid `edited` for other reasons).
- **Consumers need no required input changes.** Deprecated inputs keep working
  as no-ops / ignored routing knobs. Optional `force-full-review` opts out of
  delta.
- **ADR 0003** remains the historical record for linked-issue intent resolution
  and the original write-back design; treat §4’s `ai-review` tick path and §5’s
  size routing as superseded by this ADR.
