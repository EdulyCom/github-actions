# ai-review performance baseline (pre-change)

Recorded for Phase 0 of [the time-and-quality plan](superpowers/plans/2026-08-06-ai-review-time-and-quality.md).
Every later phase gate is measured against these numbers.

**Sampled:** `EdulyCom/eduly`, `.github/workflows/ci.yml` job `🤖 AI Review`, 2026-08-05/06.
**Action version under test:** `EdulyCom/github-actions/ai-review@main` at `f011bf7`, before any Phase 0 change.

> **This table was produced by log archaeology, not by instrumentation** — the
> telemetry step added in Phase 0 Task 0.1 did not exist yet. Two numbers
> derived this way were wrong before being corrected (see *Method* below).
> That fragility is the reason the telemetry exists. Rows from instrumented
> runs are added under *Instrumented runs* once the change has merged and run.

## Job-level distribution

25 `AI Review` jobs with conclusion `success`:

| | minutes |
|---|---|
| n | 25 |
| min | 6 |
| median | 35 |
| **mean** | **34.6** |
| p90 | 49 |
| p95 | 53 |
| max | 59 |
| \>30 min | 16 (64%) |
| \>40 min | 7 (28%) |

Non-success jobs, by wall-clock at termination:

| conclusion | minutes | count | reading |
|---|---|---|---|
| cancelled | **60** | 2 | hit `ci.yml` `timeout-minutes: 60` — killed, not completed |
| cancelled | **40** | 5 | hit a prior 40-minute cap |
| cancelled | ≤26 | 8 | superseded by a new commit (concurrency cancel) |

The caller's timeout is currently **bounding nothing and killing reviews**. Phase 4 returns it to 25 minutes once the tail is fixed.

## Stage breakdown — the 59-minute run

Run [31047556547](https://github.com/EdulyCom/eduly/actions/runs/31047556547), job `92446725669`. `AI Review` was the **only** job that ran; every other CI job was skipped.

| stage | duration | share |
|---|---|---|
| **Review stage (Opus)** | **56m 04s** (`duration_ms=3363956`) | **95%** |
| Context stage (Haiku) | 2m 58s | 5% |
| Checkout | 6.4s | — |
| Reset + Publish | 7.3s | — |
| Token, gates, routing, linked issues, CI signal | ~5s | — |
| **repair / back-off / retry / salvage** | **all `skipped`, `duration_ms=0`** | **0%** |

## Turns, cost, and duration across 10 runs

| wall-clock | context turns | context $ | **review turns** | **review $** |
|---|---|---|---|---|
| 59 min | 36 | 0.31 | **138** | **31.01** |
| 53 min | 27 | 0.24 | **166** | **38.59** |
| 49 min | 24 | 0.30 | **105** | **22.94** |
| 44 min | 32 | 0.39 | **122** | **37.26** |
| 39 min | 24 | 0.22 | **89** | **18.99** |
| 28 min | 37 | 0.41 | **88** | **16.51** |
| 26 min | 27 | 0.25 | **91** | **16.72** |
| 20 min | 32 | 0.29 | **67** | **10.94** |
| 19 min | 27 | 0.24 | **70** | **11.32** |
| 6 min | 11 | 0.11 | **31** | **1.74** |

**Duration ≈ turns × ~24s.** Turns, wall-clock, and cost are one lever — reducing turns reduces all three. Mean review cost across this sample is **≈ $20**.

## Known waste, from a run's own evidence

From run 31047556547's structured `verification_evidence`:

- **Toolchain probing, every run, always failing.** `node_modules exists: false`, `which` → only `/usr/bin/node` (yarn/npx/jest/pnpm/npm all absent, exit 1), `nx` → `Cannot find module`. Result: `test_execution=skipped`. ADR 0003 §2 states the caller provisions no toolchain, so this discovery is guaranteed waste. → Phase 1 (A3).
- **Diff base chosen by model judgment on a false premise.** The model recorded *"Repo is shallow (`git rev-parse --is-shallow-repository` => true), so `git merge-base origin/develop HEAD` exits 1"* and derived the base commit by hand. The runner log contradicts it — the checkout's actual fetch was `git -c protocol.version=2 fetch --no-tags --prune --no-recurse-submodules origin +refs/heads/*:refs/remotes/origin/* +refs/tags/*:refs/tags/*`, with **no `--depth`**, full history, `origin/develop` included. Whichever way that contradiction resolves, *which diff gets reviewed* is currently an unverified model judgment. → Phase 1 (A1).

## Method (reproducible)

```bash
# 1. Job-level durations
for RUN in $(gh run list --repo EdulyCom/eduly --workflow=ci.yml --limit 40 \
             --json databaseId -q '.[].databaseId'); do
  gh api "repos/EdulyCom/eduly/actions/runs/$RUN/jobs?per_page=100" \
    -q '.jobs[] | select(.name|test("AI Review"))
        | [.id,.conclusion,.started_at,.completed_at] | @tsv'
done

# 2. Per-stage turns/cost — note mapfile + [0]/[-1], NOT head -1
gh api "repos/EdulyCom/eduly/actions/jobs/<JOB_ID>/logs" > job.log
mapfile -t T < <(grep -oE 'num_turns": *[0-9]+' job.log | grep -oE '[0-9]+')
# T[0] = context stage, T[-1] = review stage
```

### Two errors this method produced before correction

1. **"66 Bash tool calls"** — actually the 22-entry `--allowedTools` allowlist echoed 3× in the action's inputs dump. Tool *names in text* are not invocations.
2. **`head -1` conflated the stages** — it returned the Context stage's 36 turns / $0.31 and reported them as the Review stage's (really 138 / $31.01). Both stages write telemetry into the same job log.

Both are now pinned by tests in [`ai-review/lib/metrics.test.js`](../ai-review/lib/metrics.test.js), and the telemetry step parses the execution log structurally so neither is reachable again.

## Instrumented runs

_Empty until the Phase 0 telemetry step has merged and run. Gate: ≥3 real runs with a rendered summary table and verdicts matching what the un-instrumented pipeline would have produced._

| date | run | context | review | repair | retry | total turns | total $ | wall-clock |
|---|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | — | — |
