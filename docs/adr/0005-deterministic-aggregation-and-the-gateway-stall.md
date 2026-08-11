# ADR 0005 — Deterministic aggregation, schema-derived findings, and the gateway stall

- **Status:** Accepted
- **Date:** 2026-08-10
- **Relates to:** ADR 0001 (gate contract — unchanged), ADR 0004 (structured-output
  repair — retained, not deleted). Implements PR-A/PR-B and reshapes PR-C of
  `docs/superpowers/specs/2026-08-07-ai-review-parallel-review-design.md`.
- **Relates to:** issue #43 (the stall, unresolved and upstream)

## Context

`ai-review` was taking 25–85 minutes per PR. Measured across **682 non-skipped
review jobs** in 7 consumer repos: median 25.1 min over the last 7 days, 50.3%
over 25 min, **32 runs (4.7%) killed by the caller's `timeout-minutes`**, and
$847.56 spent in ~29 hours.

The review stage was median **87%** of job wall-clock, duration is linear in
turns (`≈ turns × 24s`), and 89% of traffic routed to Opus.

## Decisions

### 1. Latency work is separate from correctness work

The hotfix (#36) changed model IDs, widened the routing band 15/400 → 25/800,
bumped `claude-code-action`, and gated the retry on elapsed time. Measured after:
median **12.4 min**, mean cost **$6.98**, **zero** timeout kills.

The routing band is still a stopgap. The remaining 12.4 → ~10 min needs the
parallel fan-out (PR-D), not more configuration.

### 2. Facts the model can be handed are staged, not re-derived

The review prompt used to instruct the model to *"discover the default branch
yourself"* and diff against it. A model deriving the base from a false premise
reviews the wrong range and reports confidently on it.

`lib/prep.js` + `lib/write-manifest.js` stage `base_sha`, `head_sha`,
`changed_files`, `churn`, `total_fullfile_bytes`, `symbol_manifest`, `title_ok`
and `no_tests_for_changed_logic` into `.ai-review/manifest.json` (schema 1,
frozen by spec §6 so PR-D consumes it unchanged).

**The latency claim for this was not demonstrated.** A paired run on the same
diff gave −9% turns but **+14% wall-clock** — inside the 59–98 turn noise band
observed for comparable diffs. It merged on the correctness argument and as
PR-D's prerequisite, not on speed.

### 3. Findings are derived from schema-validated output, not written by the model

Spec PR-C would have replaced `structured_output` with model-written findings
files *and* deleted `--json-schema` plus the repair/retry/salvage chain. That
trades an **enforced** contract for a **detected** violation: a malformed file
becomes a failure rather than a correction, on 7 repos with no staging ring.

Instead: two **optional** schema fields (`findings[]`, `files_reviewed[]`) are
split into the artifacts `lib/aggregate.js` reads by `lib/derive-findings.js`.

Consequences:

- Shape is enforced **at generation** by the CLI.
- The model holds **no `Write` grant**. It previously needed one, on a session
  that ingests the PR diff, PR body and linked-issue bodies, while Publish
  `require()`s JS from `github.action_path` in-process with a write-scoped App
  token. The primitive is removed rather than fenced — and fencing is a trap:
  Claude Code **accepts a `Write(path)` permission rule and never consults it**
  (only `Edit(path)` and `Read(path)` are checked), so the obvious scoping
  would look correct in review and enforce nothing.
- The **score-gap failure mode is unreachable by construction** — both artifacts
  come from one array, so every finding has exactly one score.
- `--json-schema` and the recovery chain are **retained**. PR-C's deletion is
  no longer necessary.

### 4. Aggregation ships in shadow mode

`lib/aggregate.js` implements spec §6 fail-closed: absence and cleanliness are
never the same byte pattern. It runs beside the live path, gates nothing, and
feeds the **same `recompute.js`** the real verdict uses.

Four measured runs: **P0/P1 counts matched and verdicts agreed in every one.**
Divergences were advisory-only and each explained by the confidence filter.

Deleting `structured_output` waits on that agreement holding across other
repos — evidence no design argument substitutes for.

### 5. One open deviation from the frozen spec, recorded not silent

- **Reconciliation runs before the confidence filter** (spec §6 orders 4 then
  5). In the spec's order a finding the scorer *upgrades* to P1 is still
  filtered on the finder's original P2 label — the strictest threshold applied
  to the least severe reading, fail-**open** on gate-blocking findings. Pinned
  by a test.
- **Pairwise-disjointness (§6 step 2) shipped one release late — now closed.**
  It was vacuous at roster size 1, so it was deferred; `lib/roster.js` and
  `aggregate.js`'s `partition:` checks now assert it in both places, because
  the roster can only assert what it emits and a role file arrives from a model
  stage that can claim an assignment nobody made.
- **`assignments.json` extends spec §6's frozen example rather than matching
  it byte-for-byte.** Each role additionally carries `artifact` (the file path
  the role writes — needed once `scorer` sits in `roles[]` alongside the
  findings-writing roles, since it writes a different one) and `effort`;
  top-level `findings_roles` is the pre-filtered list to pass as `aggregate()`'s
  `roster` (excludes `scorer`); and `modifies_reviewer_guidance` replaces the
  spec's `modifies_claude_md`, matching the field name `lib/prep.js`'s manifest
  already uses rather than introducing a second name for the same fact. All
  additive or a rename to match existing code, never a narrowing of the frozen
  shape.

### 6. The P2/P3 confidence floor is 75, set from data

Confidence is a `0/25/50/75/100` enum. The spec's floor of **80 admitted only
100** — across three shadow runs, **8 of 8 dropped findings were at 50 or 75**,
never marginal. At 75 the "might be real, wasn't able to verify" band the
rubric's recall bias depends on survives, and 50 still drops. A test asserts
every floor lands on a rung. Spec §7a and §11 q2 asked for exactly this.

### 7. The stall is upstream and is not fixed here

Seven occurrences: a model stage hangs on its **first turn** and returns
`num_turns: 1`, `$0`, zero tool calls after ~27.6 min — `duration_ms` 1,647,262
/ 1,666,947 ×2 / 1,656,307 / 1,658,923 / 1,654,722 / 1,658,419, a **1.2%
spread** across three repos, two model IDs, and both the context and review
stages.

**Three fixes were attempted and all three were falsified by measurement.**
Recorded so none is re-tried without new evidence:

| Attempt | Falsified by |
|---|---|
| `--fallback-model` | Live during run 31317613715; stall happened anyway. A fallback triggers on an overloaded *response* — this gateway never answers |
| `API_TIMEOUT_MS` | Run 31356469199 stalled 27m36s with it set to 180000 (3 min) |
| Disabling the context stage | Run 31362834124 stalled in the **review** stage with context skipped. The "4 of 5 stalls are context" reading was selection bias — context was simply always first |

`lib/metrics.js` now detects the fingerprint and warns, so a run diagnoses
itself. That is observability, not a fix. See issue #43.

## Consequences

- Consumers need no changes. Inputs and the four outputs are unchanged
  throughout; `recompute.js` is untouched.
- `enable-context-stage` and `api-timeout-ms` exist as escape hatches. Neither
  bounds the stall; both are documented as such.
- PR-D remains the only path to the spec's ~10-minute target. It **multiplies
  model stages per job**, so it multiplies stall surface — issue #43 should be
  understood before it lands, not after.

## Note on how the defects here were found

Eight real defects in this work were caught by `ai-review` reviewing its own
PRs, including three fail-opens where a raised P0 produced `verdict: pass`
(garbled severity, missing confidence, duplicate finding ids). Unit tests,
actionlint, zizmor and YAML validation passed on every one — they check
container shapes, and all three defects were in the **joins between** them.

That is the strongest available argument for the gate, and it is why
aggregation ships in shadow mode rather than gating on first contact.
