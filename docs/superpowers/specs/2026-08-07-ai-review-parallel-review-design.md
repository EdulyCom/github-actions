# `ai-review` parallel code-review architecture — design

**Status:** approved shape, not yet implemented. Sequencing in §8 governs how it lands.
**Supersedes:** the 8-angle/14-section vendored rubric as the *finding* methodology (the rubric's
*scoring* vocabulary survives — see §3).
**Authors:** Opus (architecture), Fable (coverage/coherence redesign + calibration review), synthesized
by Claude Sonnet 5 from a live design session with the repo owner.

---

## 1. Directive and binding constraints

The owner's instruction for this phase, verbatim:

> "the review needs to be code-review skill run (not our set criteria). run parallel with OSH
> orchestration and delegation in order to get the best quality, at best possible cost and time."

Two earlier constraints from the same engagement remain binding and were treated as non-negotiable
throughout this design:

- **"the rubric scoring method needs to stay in order to be able to set a value for the result and
  decide to pass or fail the PR."** The P0–P3 severity vocabulary, the confidence formula, and
  `recompute.js`'s input contract are unchanged. What changes is *how findings are produced*, never
  how they are scored or gated.
- **"must read all. the risk is a bad PR and broken app. we had enough of that."** Full contents of
  every changed file, always. No sampling, no truncation, no diff-hunk-only reasoning. This was
  reaffirmed after two later course-corrections in this same session (see §2) and is treated as the
  single hardest constraint in the whole design.

Two refinements added mid-design, both owner-directed and both resolved below:

- **Sharding by raw byte-balance is the wrong partition** — it conflates *coverage* (read every file)
  with *coherence* (understand relationships between files), and any partition drawn on files alone
  can be defeated by a relationship that crosses it. §4 replaces it.
- **Parallelism is an option, not a mandate.** Fan-out must be the thing that happens when a diff
  exceeds what one reviewer can hold with full comprehension — not a fixed pipeline every PR pays
  coordination cost for. §5 makes this a natural collapse, not a second code path.

**OSH tiering**, as instructed: **O**pus orchestrates, judges, and holds the parts of the review that
must stay independent of the rest (intent). **S**onnet executes the exhaustive-read work and reports
facts. **H**aiku collects information, does simple mechanical tasks, and scores.

---

## 2. Where this picks up

Two commits already landed on `main` (PR #33) as an incident fix, ahead of this design:

| Commit | What it did |
|---|---|
| `5f08957` | Restored the Sonnet routing band (`3/60` → `15/400`) that a prior commit (`7168977`) had narrowed, which had routed nearly every real PR to Opus and taken the review stage from a ~10–13 min baseline to a 34.6-min mean / 59-min max, with jobs cancelled at the caller's 60-min timeout. |
| `939a4e2` | Removed test execution from the review stage — it never once succeeded (no toolchain ever installed, `test_execution: skipped` on every sampled run, zero confidence adjustment per ADR 0004 §2) — and removed the runner allowlist (`npm`/`npx`/`yarn`/`pnpm`/`node`/`make`/`pytest`) that supported it, closing a code-execution path from PR-head content onto self-hosted runners. |

Both commits were explicitly framed as **stopgaps**. `5f08957`'s inline comment says so directly: *"Lower it again only once the review stage reviews in parallel, at which point Opus-by-default no longer costs wall-clock."* This design is that follow-through.

**New evidence gathered during this design, not present in the earlier incident write-up:** PR
`EdulyCom/eduly#3876` (41 files, +5046/−1480, churn 6526) produced **seven** CI runs on 2026-08-06,
most cancelled mid-review by the next push under `concurrency: ci-pr-<n>, cancel-in-progress: true`.
On an actively-developed large PR, a 35–60 min review is frequently cancelled before it finishes —
the org pays for Opus reviews that structurally never complete. This is treated as a first-class
design goal alongside cost: **the review must be able to finish inside the ordinary gap between
pushes.**

---

## 3. What the methodology swap actually changes

The `/code-review` slash command (`claude-plugins-official` marketplace, plugin `code-review`,
upstream `github.com/anthropics/claude-plugins-public`, Apache-2.0) cannot be adopted literally: its
output contract is a `gh pr comment` with linked findings — no severities, no counts, no intent, no
verdict. Invoked as-is it bypasses Publish and starves `recompute.js`, breaking the rubric-stays
constraint outright.

**Resolution:** adopt its *process*, keep the rubric's *vocabulary*.

1. **A finder** (a parallel subagent, see §4) labels each finding P0–P3, using the rubric's severity
   definitions verbatim.
2. **An independent Haiku scorer** — one that did not find the issue — rates confidence 0/25/50/75/100
   using `/code-review`'s own rubric, verbatim.
3. **Deterministic aggregation** (`lib/aggregate.js`) filters, dedupes, and counts severities itself.
   **Model-reported counts are never read.** The result is handed to `recompute.js`, unchanged.

This is *stricter* than today, not looser: today one Opus session self-reports its own `counts` and
nothing checks them. Under this design a P0 must be found, labelled, and independently scored before
a deterministic counter admits it.

### Rubric elements with no `/code-review` equivalent

| Rubric element | Decision | Where it lives |
|---|---|---|
| Intent alignment (Angle H) — `intent: deviated` is a hard blocker | **Keep** | Dedicated intent role, structurally isolated (§4) |
| Checklist verification | **Keep** | Same role — it already holds PR body + linked issues |
| Conventional-Commits title | **Keep, made deterministic** | Regex in prep step |
| i18n, multi-tenancy scoping, DB migration safety | **Keep** | Folded into cluster-reviewer checklists — these are per-file properties and partition cleanly |
| Security, reliability, performance | **Keep** | Cluster-reviewer checklists. `/code-review` excludes "general security issues" by default; this pipeline does not weaken that |
| `no_tests_for_changed_logic` (−15) | **Keep, made fully deterministic** | Path classification: `has_logic_change && !has_test_change`, from the manifest — removed from model judgment entirely |
| `coverage_below_threshold_on_critical_paths` (−5) | **Dropped in v1, documented** | No credible deterministic source and no role positioned to judge it. It is the *lesser* of two mutually exclusive penalties in `recompute.js`, so the gate impact of dropping it is small. Follow-up role if telemetry shows it mattered (open question, §11) |
| `tests_failing` / `test_execution` / `verification_evidence` | **Kept as constants** | `false` / `"skipped"` / `[]` — matches reality since `939a4e2` |
| The 8-angle scan itself | **Retired as the finding method** | Its severity/confidence/merge-risk/intent-status vocabulary is retained verbatim; the scan procedure is replaced by the roles in §4 |

### Vendoring, not live-fetching

Today's review invocation loads `plugins: superpowers@superpowers-marketplace` /
`plugin_marketplaces: https://github.com/obra/superpowers-marketplace.git` — an **unpinned git URL on
the gate's hot path**, feeding a pipeline whose later steps hold a write-scoped GitHub App token. This
is a supply-chain and prompt-injection liability independent of everything else in this design, and is
worth fixing on its own merits.

`/code-review`'s methodology is vendored into `ai-review/review/`, one self-contained prompt file per
role (subagents receive only their own system prompt, not the parent's context — every role prompt
must be self-sufficient). A `review/UPSTREAM.md` records the source repo, commit SHA, retrieval date,
and a content hash; a weekly **non-gating** `methodology-sync.yml` opens a PR when upstream drifts.
`plugins:`/`plugin_marketplaces:` are deleted from every invocation.

Verbatim, must not be paraphrased: the five confidence-rubric bullets, the false-positive class list,
and *"Do not check build signal or attempt to build or typecheck the app."*

---

## 4. Coverage and coherence — the corrected partition

**This section supersedes byte-balanced sharding.** Byte-balancing conflates two different jobs onto
one axis: *coverage* (read every file) and *coherence* (understand relationships between files). No
partition of files — by bytes, by directory, by import graph — can fully preserve coherence, because
any boundary can be crossed by a relationship (a shared type touched in one package with consumers
changed in another). The fix is not a smarter partition; it is not asking the partition to carry a job
it structurally cannot do.

### Three roles, three different inputs

**Coverage — clustered reviewers, R1..Rk.** The unit of partitioning is a *cluster* of related files,
not a byte count:

1. From `git diff --numstat` against the merge base, list changed paths with their **full-file byte
   size at HEAD** (`git cat-file -s`) — reviewers read full contents, so full-file size is the true
   cost, not diff churn.
2. Build adjacency edges among changed files only: same directory subtree; test↔source naming pairs
   (`foo.test.ts` ↔ `foo.ts`); import/require statements between changed files (one cheap grep pass).
3. Union-find the edges into clusters. Clusters, not files, are the packing unit.
4. Pack clusters into K bins via first-fit-decreasing (K from §5). A cluster that alone exceeds the
   per-reviewer budget is split at file boundaries only, and the affected paths are flagged in the
   manifest so the tracer (below) knows that cluster's internal edges are still its responsibility.

Each Rᵢ reads 100% of every assigned file's contents and runs the rubric's per-file angles (A local,
B local, D, E, F, G) plus the applicable checklist sections. It writes
`.ai-review/findings/reviewer-<i>.json` including `files_reviewed`, cross-checked by aggregation
against the manifest.

**Coherence — one cross-file tracer, X. Assigned zero files.** Its input is a machine-generated
**symbol manifest** — changed/deleted/renamed function signatures, exported symbols, and types,
extracted deterministically from diff hunk headers in the prep step (regex-grade extraction; no
compiler needed). X has repo-wide Grep/Read and one mandate: for every manifest entry, find every
consumer — inside the diff or outside it, inside one cluster or across two — and check whether the
change breaks it (Angle C); for every deleted guard, find where the invariant is re-established or
report that it is not (Angle B, cross-file half). Because X follows *relationships* rather than a file
list, **no partition boundary can hide an edge from it.** This is the structural answer to "understand
everything together" — there is a stage whose entire mandate is the together-ness, independent of how
coverage happened to be sliced.

**Frame — one intent reviewer, H. Assigned zero files, sees the diff last.** Receives only
`.ai-review/linked-issues.json` and the PR title/body first, derives the intent contract, and only
then opens the diff. The rubric's "run Angle H cold, before any diff analysis" stops being an
instruction the model has to resist rationalizing around (today's rubric spends a whole table on
"rationalizations that violate this rule") and becomes structurally true: it is a separate subagent
that cannot see diff analysis that does not yet exist. H owns `intent`, the checklist, and the
Conventional-Commits/title checks.

**Historical-context perspective** (`/code-review`'s git-blame / prior-PR-comments / code-comment
angles): one whole-diff Sonnet agent working from hunks plus targeted reads. It does not duplicate the
exhaustive full-file reads — that guarantee already lives with R1..Rk — which is why this perspective
stays cheap.

### Why this design and not the alternatives

- **vs. pure byte shards** (Opus's original): relationships are a first-class role, not a hoped-for
  side effect of balance.
- **vs. dependency-clustered shards alone, no tracer:** clustering reduces cut edges; it does not
  eliminate them. X makes the residual cut edges harmless — belt and suspenders, and the belt
  (clustering) also improves each Rᵢ's local comprehension.
- **vs. `/code-review`'s own model, unmodified** (every perspective agent reads everything): does not
  scale — five perspectives each reading every file fully is 5× the read cost and can exceed a single
  context on eduly-class PRs. This design keeps perspectives cheap and partitions only the expensive
  exhaustive-read job.
- **vs. deeper hierarchical fan-out:** adds coordination depth for no benefit at the K≤4 scale this
  problem actually needs.

### No partition can ever split a file's contents

The manifest schema (`.ai-review/assignments.json`, §6) assigns whole paths to roles; there is no
byte-range or line-range field, so splitting a file's content across two reviewers is
**unrepresentable, not merely avoided.** The prep step asserts the partition property — clusters
pairwise disjoint, union equal to the full changed-file list — and hard-fails the job if violated.

---

## 5. Adaptive parallelism — K is a read-budget, not a size cap

**Principle:** fan-out activates only when the work physically exceeds what one reviewer can hold with
full comprehension in one context. Below that, one reviewer *is* the optimum — not a degraded
fallback — and fan-out would only add coordination cost for nothing. This is "parallelism is the
option when possible" made literal, not aspirational.

```
K = clamp(ceil(total_fullfile_bytes / BUDGET), 1, 4)
```

`total_fullfile_bytes` = sum of full-file size at HEAD for every changed file (not diff churn — the
cost that matters is what gets read, and reviewers read full files). `BUDGET ≈ 130 KB` (~35K tokens of
file content, leaving a Sonnet reviewer room for surrounding-context reads and its own reasoning).
Secondary guard: fan out past ~20 changed files even under the byte threshold, since many small files
cost per-file attention independent of total bytes.

Cap is **4, not 8.** Opus's original cap of 8 was set before the rate-limit exposure of K concurrent
Sonnet reviewers plus a wave of Haiku scorers through one gateway/key was considered; K≤4 is the
conservative number until measured otherwise.

**What K=1 looks like architecturally — the same pipeline, a smaller roster, no second code path.**
Prep always emits the manifest and roster, regardless of size. The minimum roster is `{R1 (with X's
Angle C folded in when the symbol manifest is small — say under 10 changed exported symbols), H}`. H
runs concurrently with R1 even at K=1, since it needs no file reads to start, so its presence costs
zero extra wall-clock. Aggregation validates whatever roster the manifest declares; it is indifferent
to roster size. **The architecture collapses by roster size, not by branching logic.**

This also means the existing `sonnet-files-threshold`/`sonnet-churn-threshold` inputs stop being the
topology knob — reviewers are always Sonnet, the orchestrator always Opus, scorers always Haiku,
per the OSH mandate, so per-diff model routing is moot. The two inputs stay accepted for backward
compatibility (same deprecation pattern as `test-command`) but their description changes to reflect
they no longer route models.

---

## 6. Findings → severity → gate

### Frozen interfaces

These are frozen by this document so the implementation parcels (§13) can be written independently.

**`.ai-review/assignments.json`** — written by the deterministic prep step, read by every role's
prompt assembly and by `lib/aggregate.js`:

```json
{
  "schema": 1,
  "roles": [
    { "role": "reviewer-1", "kind": "coverage", "model": "claude-sonnet-5", "assigned_files": ["src/a.ts", "src/b.ts"] },
    { "role": "tracer",     "kind": "coherence", "model": "claude-sonnet-5", "assigned_files": [] },
    { "role": "intent",     "kind": "frame",      "model": "claude-opus-4-8", "assigned_files": [] },
    { "role": "history",    "kind": "perspective", "model": "claude-haiku-4-5-20251001", "assigned_files": [] }
  ],
  "changed_files": ["src/a.ts", "src/b.ts"],
  "symbol_manifest": [ { "kind": "function", "name": "authorize", "file": "src/a.ts", "change": "signature" } ],
  "has_test_change": false,
  "has_logic_change": true,
  "modifies_claude_md": false
}
```

**`.ai-review/findings/<role>.json`** — written by each role:

```json
{
  "schema": 1,
  "role": "reviewer-1",
  "complete": true,
  "model_used": "claude-sonnet-5",
  "assigned_files": ["src/a.ts", "src/b.ts"],
  "files_reviewed": ["src/a.ts", "src/b.ts"],
  "intent": null,
  "checklist": [],
  "findings": [
    {
      "id": "reviewer-1/0001",
      "file": "src/a.ts",
      "line": 84,
      "severity": "P1",
      "summary": "one-sentence defect statement",
      "failure_scenario": "concrete inputs/state -> wrong output",
      "reason": "bug",
      "evidence": "quoted line or cited grep result"
    }
  ]
}
```

**`.ai-review/scores.json`** — written by the scorer role. Amended from Opus's original shape to also
confirm or reclassify severity (§7):

```json
{
  "schema": 1,
  "role": "scorer",
  "complete": true,
  "scores": [
    { "id": "reviewer-1/0001", "confidence": 75, "severity_confirmed": "P1", "rationale": "…" }
  ]
}
```

**`.ai-review/gate-input.json`** — written by `lib/aggregate.js`, consumed by Publish. Its `review`
object is exactly `recompute()`'s parameter — **`recompute.js` and its 21 tests are unchanged.**

```json
{
  "status": "ok",
  "reason": null,
  "review": {
    "counts": { "p0": 0, "p1": 1, "p2": 3, "p3": 2 },
    "intent": "aligned",
    "test_execution": "skipped",
    "tests_failing": false,
    "no_tests_for_changed_logic": false,
    "coverage_below_threshold_on_critical_paths": false,
    "verification_evidence": [],
    "checklist": []
  },
  "kept": [ "...full finding objects, sorted P0->P3..." ],
  "dropped": [ "...findings filtered out, never discarded..." ],
  "coverage": { "expected_files": 41, "reviewed_files": 41 },
  "summary_markdown": "…",
  "warnings": []
}
```

### The aggregation algorithm

`lib/aggregate.js`, in this order:

1. **Assert roster completeness** — every `roles[*].role` in the manifest has a parseable,
   `complete: true` findings file. Any gap → inconclusive fail (§8).
2. **Assert partition integrity** — role file sets are pairwise disjoint and their union equals
   `changed_files` (structural check from §4, run again here as defense in depth).
3. **Join scores to findings by id**; assert set equality both ways. An unscored finding is a hard
   fail, never a silent drop (§8).
4. **Apply the severity-tiered confidence filter** (§7): P0/P1 candidates survive at confidence ≥50;
   P2/P3 candidates require ≥80. Filtered-out findings go to `dropped[]` — never silently discarded,
   per the rubric's own instruction that silent dropping is "the dominant cause of misses."
5. **Reconcile severity**: take the more severe of the finder's `severity` and the scorer's
   `severity_confirmed` (§7). Fail-closed direction.
6. **Dedupe survivors**, deterministically only, on exact `(file, overlapping line range, same
   category)`. No fuzzier matching, no model-mediated merge — over-counting is tolerated because it
   fails closed (more findings → lower gate confidence); a model-mediated "these are duplicates" merge
   is a channel through which a real P0 could be argued away.
7. **Inject deterministic findings**: `modifies_claude_md === true` → one P2 flagging that this PR
   changes the guidance reviewers themselves read; `title_ok === false` → one P2.
8. **Count** `p0/p1/p2/p3` from the final deduped set. **Model-reported counts are never read.**
9. **Derive `intent`** from the intent role's own field, defaulting to `"skipped"` only when that role
   states its own skip conditions were met.
10. **Derive `no_tests_for_changed_logic`** deterministically from the manifest — pure path
    classification, not model judgment.
11. **Emit** `gate-input.json`.

### Why this removes the root cause of the failure-recovery machinery, not just its symptom

Today's repair/back-off/retry/salvage steps (187 lines) exist because the *entire* review — verdict,
counts, intent, full markdown body — has to survive **one model's final turn** as a single
schema-validated blob. That is a single point of failure sitting at the end of 30–56 minutes of paid
analysis; when it misses (observed: 33 turns, $3.76, session completes, no structured output emitted),
everything is lost, so four recovery layers were bolted on to rescue it.

Under the findings-file contract there is no final-turn blob to miss:

- Findings are durable on disk the moment each role finishes. A session that dies immediately after
  writing loses nothing downstream.
- Nothing needs "repair" — there is no schema-validated final emission to miss.
- Nothing needs "salvage" — the analysis was never trapped in an execution log.
- Nothing needs "retry" — the failure mode this design cannot prevent (a role that dies before
  writing) yields a complete, correctly-classified *inconclusive* review, not a lost one.

And it closes a hazard the reverted prior attempt exposed but never named: **repair-laundering** — a
`--resume` on a session cut off mid-scan, told to "emit from the analysis you already completed,"
converts a partial review into a confidently published verdict. That path does not exist here: there
is no resume, and an incomplete role produces a missing or `complete: false` file, which is
inconclusive by construction.

---

## 7. Two calibration fixes (found during this design, not present in the original plan)

Neither the owner nor Opus's original design surfaced these. Both would have shipped silently and
degraded the gate's actual defect-catching behavior — worth stating clearly since they are the least
visible risk in this whole migration.

### 7a. The confidence filter conflicts with the rubric's own recall bias

`rubric.md`'s Verify Pass makes **PLAUSIBLE the default verdict** — "concurrency race, nil on a
rare-but-reachable path, falsy-zero treated as missing, off-by-one on a boundary the code does not
exclude. Do NOT refute for being 'speculative.'" `/code-review`'s confidence scale scores exactly that
finding class **25–50** ("might be real… wasn't able to verify"). A flat `<80` filter, adopted as
specified, would silently drop the finding class the owner's "we had enough of broken apps" stance
cares about most.

**Fix, already reflected in §6 step 4:** tier the threshold by severity. `<80` for P2/P3 candidates
(where `/code-review`'s false-positive discipline earns its keep as noise control); `≥50` for P0/P1
candidates (preserving the rubric's recall bias on the findings that actually block the gate).
Selftest logs every P0/P1 candidate the filter would have dropped, so the boundary is set from
observed data during the sequencing in §8, not guessed once and left alone.

### 7b. Nothing validates severity assignment

The Haiku scorer checks real-vs-false-positive; **severity comes solely from whichever role raised the
finding, unchecked.** A real bug mislabeled P2 instead of P1 sails straight through the gate — P2
never blocks (`recompute.js`).

**Fix, already reflected in §6 §step 5 and the `scores.json` schema:** the scorer prompt also receives
the rubric's P0–P3 definitions verbatim and returns `severity_confirmed` (or a proposed
reclassification) alongside its confidence score. Aggregation takes the more severe of the finder's
and the scorer's severity — fail-closed, consistent with the dedupe rule in §6.

---

## 8. Fail-closed matrix

Every row's outcome sets all four job outputs — `verdict: fail`, `confidence: 0`, `merge_risk: high`,
`review_event: REQUEST_CHANGES` — with a reason rendered in the posted review. `status !== "ok"` never
reaches `recompute()`; Publish posts the inconclusive review directly.

| # | Condition | Detector | Outcome | Reason (rendered) |
|---|---|---|---|---|
| 1 | Empty diff (0 changed files) | Prep step: `git diff --numstat` empty | `fail` | "No changed files between the merge base and PR head — nothing to review. Check the base branch." Not a pass — anomalous on a real PR, and the exact class the prior reverted attempt turned into a false PASS |
| 2 | Prep step fails (diff/manifest/partition) | No `continue-on-error` anywhere in prep; `set -euo pipefail` | job failure | GitHub renders the failing step directly |
| 3 | Session dies before writing anything | `.ai-review/findings/` absent or empty while the manifest names ≥1 role | `fail`, `inconclusive:no-findings-dir` | "The review session ended without producing any role output. Not a code-quality judgment. Re-run." |
| 4 | Dead role — some roles wrote, one did not | Roster assertion against the manifest's role-name set (§6 step 1) | `fail`, `inconclusive:missing-role:<role>` | "Reviewer `<role>` produced no output; the change was not fully reviewed." Absence and cleanliness are never the same byte pattern |
| 5 | Malformed role file (bad JSON, wrong schema version, missing `complete`, `complete: false`, malformed id) | Schema validation before any counting | `fail`, `inconclusive:malformed:<role>` | "Reviewer `<role>` returned unparseable output." |
| 6 | Coverage mismatch vs partition | §6 step 2 / §4's partition-integrity assertion | `fail`, `inconclusive:coverage:<detail>` | "Reviewer `<role>` was assigned 11 files and reported reviewing 8. The change was not fully read." Makes "must read all" enforceable, not merely instructed. **Honest limitation:** this checks *claim* completeness, not reading truth — there is no cheap proof a reviewer actually comprehended what it claims to have read. It is a tripwire against the common failure (silent truncation), not a guarantee, and the ADR must say so plainly |
| 7 | Zero findings, full coverage | `findings: []` on every role, all coverage/partition checks pass, every role `complete: true` | **`pass`** — a real clean result | Normal PASS banner. Must not be conflated with rows 3–6 |
| 8 | Scorer file missing | `scores.json` absent or `complete: false` | `fail`, `inconclusive:missing-scores` | "Findings were produced but not independently scored." |
| 9 | Scorer coverage gap | `set(scores[*].id) != set(all candidate ids)`, either direction | `fail`, `inconclusive:score-gap` | "N findings were left unscored." Prevents "unscored ⇒ dropped ⇒ clean" |
| 10 | `intent` missing/invalid from the intent role | Field absent or not in `aligned\|partial\|deviated\|skipped` | `fail`, `inconclusive:no-intent` | "Intent alignment could not be established." Structurally fixes the prior reverted attempt's "judge ruled on intent without the brief" defect — nothing can rule on intent without the intent role's own output existing |
| 11 | Marketplace unreachable | N/A — no `plugins:`/`plugin_marketplaces:` remain after vendoring (§3) | — | — |
| 12 | PR closed/merged mid-review | Re-read PR state before posting | Skip posting; outputs stay empty | Consumer gates already treat empty as non-pass |
| 13 | Aggregation itself throws | `try/catch` around `lib/aggregate.js` | `fail`, `inconclusive:aggregator-error` | "The deterministic aggregation step failed." |
| 14 | Job wall-clock exceeded | Caller's `timeout-minutes` (recommend lowering to **20**, from today's 25) | job cancelled | Consumer's gate sees empty ⇒ non-pass |
| 15 | Model drift (`model_used` != manifest) | Aggregation comparison | **warning only**, review proceeds | Cost-drift signal in the banner/telemetry, not a correctness failure |

---

## 9. Cost and wall-clock model

**Baseline (measured, n=25, `EdulyCom/eduly`, recovered from git history):** median 35 min, mean 34.6,
p95 53, max 59; 64% >30 min. Review stage alone = 95% of the job on the sampled 59-min run.
`duration ≈ turns × ~24s`. Review turns ranged 31→166 across 10 runs, cost $1.74→$38.59, **mean ≈$20**.

**Assumptions, stated to be falsifiable:**

- ~24s/turn for Sonnet/Opus turns; Haiku faster (~10–12s), not directly measured.
- **Foreground subagent parallelism is real, not a hope.** Fable's correction to Opus's original
  framing: `/code-review` — the artifact being vendored — is *itself* built on parallel subagent
  dispatch ("launch 5 parallel Sonnet agents") and runs in routine production via `claude -p`
  (headless), which is the same mode `claude-code-action` uses. This is treated as validated by
  existence proof, not as an open risk. The per-shard timestamp measurement in §8 of the sequencing
  plan is kept because it is nearly free, not because the underlying capability is in doubt.
- A wave's wall-clock is the max over its concurrent roles, not their sum.
- Removed work is real: base-commit archaeology (deterministic now), toolchain probing (deleted in
  `939a4e2`), the 8× redundant re-read of the same files across 8 sequential angles in today's single
  session, `comment_markdown` composition (deterministic now).

**Projection:**

| Case | K | Roster wall-clock (max of concurrent roles) | **Job total** | **Cost** |
|---|---|---|---|---|
| Tiny (a few files, well under budget) | 1 | ~3–5 min | **~6 min** | **~$0.60–1** |
| Typical (handful of files, tens of KB) | 1–2 | ~5–7 min | **~9–10 min** | **~$5–8** |
| **Heavy — PR #3876 (41 files, 6526 churn)** | **3–4** | ~6–8 min | **~10–13 min** | **~$14–20** |
| Pathological (well past 4× budget) | 4 (capped) | ~12–15 min | **~18–20 min** | ~$25–30 |

**Against the baseline:** mean job **34.6 min → ~9–10 min**; the heavy case **56–66 min (often never
completed) → ~10–13 min**; p95 **53 → ~18–20 min**. Cost mean **$20 → ~$5–8**; heavy case **$38.59 →
~$14–20**.

**The cancellation tax, explicitly.** PR #3876 produced seven runs on 2026-08-06, most cancelled
mid-review by the next push. At today's cost, that PR's true spend is roughly seven partially-consumed
Opus reviews (~$10–20 each) for **zero completed reviews**. At ~10–13 min, a review lands inside the
ordinary gap between pushes on an actively-developed PR — comparable or lower total spend, and actual
completed reviews instead of none. This is a structural argument, not one that depends on the exact
per-turn cost estimates being right — it only requires the review to finish in roughly a third to a
half of today's time, which the K=4 cap conservatively delivers.

**GitHub job-minutes:** unchanged — still one job, one runner. No per-shard checkout, no
matrix-job multiplier.

---

## 10. Risk register

### The 8 defects from the previously reverted attempt (`536507c` → `cbec35a` → `3fbb572`)

| # | Defect | Structural mitigation here |
|---|---|---|
| 1 | Silent prep failure → confident PASS (`continue-on-error` let diff/pack fall back to `{}`/`""`; workers reviewed an absent diff; judge approved at confidence 100) | `continue-on-error` removed from every prep step; `set -euo pipefail` throughout. A prep failure fails the job (matrix row 2). Aggregation independently re-derives the changed-file set and requires it to equal the manifest's partition — "reviewed 0 of 41" is matrix row 6, an inconclusive fail, never a pass |
| 2 | Cross-round finding-id collision (`${task.id}#${i}` reused across rounds) | **No rounds exist.** Ids are `<role>/<4-digit>`; role names are unique per run against a hardcoded manifest; dedupe keys on content `(file, line-range, category)`, not id, so even a pathological id collision cannot merge two distinct findings |
| 3 | Judge ruled on intent without being given the intent brief | **No judge.** `intent` is a field owned by exactly one role (§4's frame role) whose input is the linked-issues + PR body, consumed by `recompute.js` unchanged. Missing → matrix row 10 → inconclusive. A verdict cannot be reached without it |
| 4 | "Exactly one exec worker" was prompt-only, never schema-enforced | No exec worker exists in this design — `939a4e2` already removed the runner allowlist from the review session entirely. General principle: enforcement lives at the artifact consumer (aggregation), never in the producer's prompt |
| 5 | Log-name collisions across rounds overwrote telemetry | One `claude-code-action` invocation → one execution log. Nothing to overwrite; per-role telemetry is attributed structurally, never by grepping |
| 6 | `setOutput` delimiter forgeable from model-controlled text | Model text never reaches `core.setOutput` or `$GITHUB_OUTPUT`. The four job outputs are machine-generated enums/integers from `recompute.js`. Findings reach the GitHub API via `fs` read + `pulls.createReview` inside `github-script` — no shell, no delimiter, no interpolation |
| 7 | Timeout raced without cancelling the loser (`Promise.race` orphaned the SDK subprocess) | No Node orchestrator, no `Promise.race`. Concurrency is Claude Code's own subagent scheduler inside one process; wall-clock is bounded by the caller's job `timeout-minutes`, which kills the whole process tree |
| 8 | README documented a pipeline that no longer shipped | A CI assertion (part of §13 Parcel 1's deliverables) greps `README.md` for every role name in the roster and for zero occurrences of `structured_output`/`context.md`/`salvage`/`repair`/`retry` — a doc describing a deleted pipeline fails CI |

### New risks

| Risk | Severity | Mitigation |
|---|---|---|
| **API rate limiting** — K concurrent Sonnet reviewers plus a wave of Haiku scorers through one gateway/key | Medium | K capped at 4 (down from Opus's original 8, per Fable's correction). Telemetry records per-role retry/backoff. Zero re-serialization observed on selftest is a gate criterion before wider rollout |
| **The confidence filter silently weakens the gate on recall-critical findings** (§7a) | High if unaddressed — **already addressed in this design** | Severity-tiered threshold (§6 step 4): ≥50 for P0/P1, <80 for P2/P3. Selftest logs dropped P0/P1 candidates so the boundary is set from data |
| **Severity assignment is unchecked** (§7b) | High if unaddressed — **already addressed in this design** | Scorer confirms/reclassifies severity; aggregation takes the more severe of the two (§6 step 5) |
| **`--agents` inline JSON quoting inside a `claude_args` block scalar** | Medium | Assembled by the prep step as compact JSON into a step output, single-quoted once. Content is action-authored (role names, model ids, vendored prompt paths) — never PR-derived. A unit test asserts the emitted string parses and round-trips |
| **Prompt injection via PR-head `CLAUDE.md` / `.claude/review-profile.md`** | Medium — **not a regression**, today's single session already reads the full PR-head tree | Repo-supplied markdown is framed as data describing conventions, never instructions, in every role prompt that reads it. A deterministic P2 is injected whenever the diff touches `CLAUDE.md`/`.claude/review-profile.md` (§6 step 7) — model-independent, so a suppression instruction embedded there cannot suppress its own flag |
| **`CLAUDE_CODE_SUBAGENT_MODEL` or similar env override silently changes a role's model org-wide** | Medium | Detected, not assumed: `model_used` per role compared against the manifest, surfaced as a warning (matrix row 15), never a correctness failure |
| **Vendored methodology drifts from upstream** | Low | Weekly non-gating `methodology-sync.yml` + `UPSTREAM.md` content hash + a test asserting the retained verbatim blocks are still present |
| **Coverage cross-check verifies claims, not comprehension** (Fable's honest limitation on matrix row 6) | Low, but must be documented, not implied away | Stated plainly in the ADR: this is a tripwire against silent truncation, not a proof of reading |
| **Composite-step timeouts don't exist; a hung role now hangs K roles' spend behind it** | Low | Unchanged mitigation (caller job-level timeout + fail-closed aggregation), but the ADR should note a timeout now costs up to K× the tokens of a single hang — one more argument for keeping K conservative |
| **`coverage_below_threshold_on_critical_paths` dropped in v1** | Low | Documented; only fires when the larger `no_tests_for_changed_logic` penalty is already false. Follow-up role if telemetry shows the loss matters |

---

## 11. Open questions for the human

1. **`coverage_below_threshold_on_critical_paths`** stays dropped in v1 (no credible deterministic
   source; small gate impact as the lesser of two mutually exclusive penalties). Confirm acceptable,
   or authorize a dedicated follow-up role.
2. **Severity-filter threshold values** (§7a: ≥50 for P0/P1, <80 for P2/P3) are a starting point, not
   a measured constant. Selftest during sequencing (§12) will log the P0/P1 candidates the filter
   would have dropped at various thresholds — confirm you want the boundary tuned from that data
   before it locks in, rather than shipped as specified here.
3. **The Haiku context stage** (today's steps 10–11) becomes largely redundant once the tracer role
   and the deterministic symbol manifest exist. Confirm folding it into deterministic prep or deleting
   it outright in the PR that lands fan-out, rather than carrying a vestigial flaky model stage.

---

## 12. Sequencing

Five PRs, each independently revertible, each proven on `.github/workflows/selftest.yml` before the
next opens. The previously reverted attempt failed from changing transport, methodology, and
orchestration all at once with no production signal in between — this sequencing exists specifically
to not repeat that.

**PR-A — Instrument and extract. Zero behaviour change.**
Telemetry (per-stage turns/cost/duration, `if: always()`, `continue-on-error`, after Publish). Extract
`lib/publish.js` from the current ~340-line inline Publish step, moved verbatim. A guard against
dangling/duplicate `steps.<id>` references (nothing catches these today except a paid Opus run).
**Gate:** 3 selftest runs, identical verdicts to pre-change, per-stage numbers visible in the summary.
**Why first:** every later gate is a measured number against this baseline, and every later PR edits
code that now has tests around it.

**PR-B — Deterministic prep. Behaviour-neutral for the verdict.**
The prep step computes `base_sha`/`head_sha`/the changed-file list deterministically; the review
prompt is edited to trust the staged values and stop re-deriving them. Still one serial session, still
`structured_output`, still the full repair/retry chain.
**Gate:** transcripts contain zero `git merge-base`/`is-shallow-repository`/`gh pr view` turns;
findings identical on ≥3 paired PRs; mean turns down materially.
**Why here:** lands the exact artifacts fan-out needs, and independently fixes the "model derived the
diff base by hand on a false premise" hazard already present on the *current* path.

**PR-C — The pivot: findings files replace `structured_output`. Still serial.**
Single role (`review-serial`), one session, one model, writes `.ai-review/findings/review-serial.json`
+ `.ai-review/scores.json` (self-scored in this PR; the independent scorer role arrives in PR-D). Add
`lib/aggregate.js` and rewrite Publish to read `gate-input.json`. **Delete** `--json-schema`, repair,
back-off, retry, salvage, the exec-log snapshot. `recompute.js` untouched.
**Gate:** verdicts match the pre-change run on ≥3 paired PRs; a deliberately-corrupted findings file
yields `inconclusive`, not a pass; unit tests green.
**Why the retry chain dies here and not earlier:** deleting it while still on `structured_output` would
turn every intermittent miss into an unrecoverable inconclusive fail. It is only safe to delete once
its root cause (§6, "why this removes the root cause") no longer exists.

**PR-D — Fan-out, coverage/coherence split, methodology swap.**
The manifest/cluster/tracer/intent roster from §4 and §6; the severity-tiered confidence filter (§7a);
severity reconciliation (§7b); the adaptive K from §5; the vendored methodology from §3; deletion of
`plugins:`/`plugin_marketplaces:`; the Haiku context stage folded into prep or deleted (open question
3).
**Gate:** roster complete on 5/5 consecutive selftest runs; per-role timestamps confirm concurrent
(max-not-sum) wall-clock; zero rate-limit re-serialization observed; recall on ≥3 paired PRs is a
superset of PR-C's baseline, every miss investigated; per-role `{role, model, turns, cost}` visible in
telemetry.

**PR-E — Documentation and permanence.**
`README.md` rewritten to the shipped pipeline (enforced by PR-A's dangling-reference-style guard,
extended to check for zero mentions of the deleted mechanisms). An ADR recording: the transport
decision, the vendoring decision and its supply-chain rationale, the coverage/coherence split and why
byte-sharding was rejected, the severity-filter calibration and its data-driven tuning, and the
matrix-fan-out fallback (**not currently expected to be needed** — see §9's parallelism-is-proven
correction — but named for completeness). `docs/consumer-integration.md` timeout guidance updated
25 → 20. The `methodology-sync.yml` workflow.

**Rollback posture:** PR-C and PR-D are the only ones that change the gate's shape; each is a single
revert. Consumers track `ai-review@main`, so a revert propagates immediately — which is exactly why
PR-D does not open until PR-C has soaked on real production PRs.

---

## 13. Work decomposition — 3 parallel parcels

Disjoint file ownership, no shared state, no ordering dependency between parcels. Every interface any
two of them touch is frozen in §6 above.

### Parcel 1 — Deterministic JavaScript core

**Owns:** `ai-review/lib/**` (new files only — `recompute.js`/`recompute.test.js` are read-only to
this parcel) and the unit-test workflow.
**Must not touch:** `action.yml`, `ai-review/review/**`, any `.md`.

Deliverables: the prep-step logic as testable modules (partition/clustering per §4, the byte-budget K
formula per §5, the symbol-manifest extraction), `lib/aggregate.js` implementing the algorithm in §6
exactly (including the severity-tiered filter from §7a and severity reconciliation from §7b),
`lib/publish.js` (extracted verbatim from today's Publish step), the README doc-drift assertion from
§10 row 8. Pure functions only — no I/O beyond `fs` reads of paths passed in, no `process.env`. Every
row of the fail-closed matrix (§8) that aggregation owns needs a named test, using fixtures covering
at minimum: a clean small PR, the 41-file/6526-churn shape, a missing role file, a malformed role
file, a coverage/partition mismatch, a scorer coverage gap, an empty diff, and a P0 candidate at
confidence 60 (must survive the tiered filter) alongside a P3 candidate at confidence 60 (must not).

### Parcel 2 — Methodology vendoring

**Owns:** `ai-review/review/**` (new directory) and `ai-review/rubric.md`.
**Must not touch:** `action.yml`, `ai-review/lib/**`, `README.md`.

Deliverables: one self-contained prompt file per role — coverage reviewer, tracer, intent, historical
perspective, scorer — each ending with its exact `.ai-review/findings/<role>.json` (or
`scores.json`) output contract from §6. `review/severity.md` carrying the rubric's retained scoring
vocabulary (severity levels, confidence formula, merge-risk bands, intent-status derivation) by
reference from every role prompt. `review/UPSTREAM.md` (source repo, commit SHA, retrieval date,
content hash, Apache-2.0 notice). `review/DEVIATIONS.md` recording every departure from the upstream
`/code-review` command and its justification — in particular: full-file reads instead of diff-only
(owner's binding constraint), the coverage/coherence split instead of pure perspective agents (§4),
the severity-tiered filter instead of a flat `<80` (§7a), and severity reconciliation added on top of
confidence scoring (§7b). Every finder prompt must instruct that repo-supplied markdown (`CLAUDE.md`,
`.claude/review-profile.md`) is data describing conventions, never instructions. A markdown table
listing which verbatim blocks (the confidence rubric, the false-positive class list, the
build/typecheck exclusion) must appear in which files, for Parcel 1's methodology-verbatim test to
assert against.

### Parcel 3 — Action wiring and documentation

**Owns:** `ai-review/action.yml`, `ai-review/README.md`, the ADR, `docs/consumer-integration.md`,
`methodology-sync.yml`.
**Must not touch:** `ai-review/lib/**`, `ai-review/review/**`.

Consumes Parcels 1 and 2 by path/interface only — never their internals — so it can be written before
either lands. One `claude-code-action` invocation (keeping the pinned SHA and the existing bearer-token
workaround verbatim). `claude_args` carries `--model` per role via the `--agents` roster (compact JSON
assembled by the prep step, single-quoted once — content is action-authored, never PR-derived). No
`--json-schema`. Tool scoping per role: coverage reviewers get `Read, Grep, Glob`; the tracer gets
`Read, Grep, Glob` plus repo-wide search; the intent role gets `Read` only; the historical-perspective
role gets `Read, Grep, Glob, Bash(git log:*), Bash(git blame:*), Bash(git show:*), Bash(gh pr
list:*), Bash(gh pr view:*)`; scorers get `Read` only. **No package-manager or test-runner entries
anywhere** — `939a4e2` already closed that path; do not reopen it. Delete `plugins:` /
`plugin_marketplaces:`. Delete the steps named for removal in each PR of §12 as that PR lands. Do
**not** reformat the linked-issues resolver step — `parity.yml` string-matches it verbatim against
`ai-qa/action.yml`. Every attacker-influenceable value reaches a shell only via step-level `env:`,
never inline `${{ }}` in `run:`. Exactly four job outputs, `verdict` empty only on a genuine skip path.
`docs/consumer-integration.md` timeout guidance updated to 20 minutes once PR-D's measurements confirm
it.

---

## Sources

- Baseline latency distribution: recovered from `docs/ai-review-baseline.md` at commit `a4252b7`
  (reverted from the working tree at `cbec35a`; not present on `main` today).
- Cancellation-tax evidence: `EdulyCom/eduly#3876` run history, 2026-08-06.
- Prior reverted attempt: `536507c` (merge) → `cbec35a` (revert) → `3fbb572` (revert merge), and its
  own final-fix-report / task reports under `.superpowers/sdd/2026-08-06-ai-review-orchestrator/`.
- `/code-review` methodology: `claude-plugins-official` marketplace, plugin `code-review`, upstream
  `github.com/anthropics/claude-plugins-public`.
- Concurrency-is-proven correction and the two calibration fixes in §7: Fable-tier architecture review
  conducted live during this design session.
