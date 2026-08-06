# ai-review Simplification Implementation Plan

> # ⚠️ SUPERSEDED — DO NOT EXECUTE
>
> Replaced by [`2026-08-06-ai-review-time-and-quality.md`](2026-08-06-ai-review-time-and-quality.md).
>
> This plan was written on **inference, before anything was measured**, and its
> central premises turned out to be wrong:
>
> - It ranked the repair / back-off / retry chain as a wall-clock factor.
>   Measured contribution: **zero** — every one of those steps was `skipped`
>   in the 59-minute run.
> - It treated removing the Haiku Context stage as "the single biggest latency
>   cut." Measured: **2m58s of a 59m job (5%)**.
> - It did not address the Review stage, which is **56m04s of that 59m (95%)**.
>
> Its structural work (schema single-sourcing, retry-gate dedup, publish-logic
> extraction, the action-reference guard) survives — carried into Phase 1 of the
> superseding plan, rescoped and sequenced behind measurement.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink `ai-review/action.yml` (1,327 lines) by deleting duplication and moving its untestable inline JavaScript into one tested module — without weakening the review.

**Architecture:** Four consolidation passes on the YAML, then one extraction. Every new file must either delete more than it adds or cover something nothing else covers; nothing is added for tidiness alone. The one change that touches review *inputs* — deleting the Haiku Context stage — is held behind a decision gate at the end of this document.

**Tech Stack:** GitHub Actions composite action, `actions/github-script`, `anthropics/claude-code-action`, `gh` CLI, Node.js `node:test` + `node:assert/strict` (no third-party deps).

## New files: 4, and why each is a must

| File | Net effect | Why not zero files |
| --- | --- | --- |
| `ai-review/lib/review-schema.json` | **−2 copies.** Replaces three verbatim ~1.1 KB inline blobs with one. | The three copies must stay byte-identical or repair/retry validate a different shape than review. This is the cheapest dedup that leaves the schema diffable. |
| `ai-review/lib/action-refs.test.js` | **+1 file, covers a real hole.** | Verified: actionlint does not check composite `action.yml` steps at all, and the repo passes it no globs. Nothing today catches a dangling `steps.<id>` reference except a live paid Opus review. |
| `ai-review/lib/publish.js` + `.test.js` | **−170 lines from action.yml**, plus tests for logic that has none. | Same rationale that already justified `recompute.js`. Two files, not four — see below. |

**Cut from the first draft of this plan (over-engineering, removed):**
- `docs/adr/0005-*.md` → folded into the Decision Gate section at the end of this file. A proposal does not need its own ADR until it is accepted.
- `lib/render.js` + `lib/checklist.js` → merged into one `lib/publish.js`. Splitting by concern was tidiness, not need.
- `lib/render.test.js` + `lib/checklist.test.js` → one `lib/publish.test.js`.
- `lib/review-schema.test.js` → its three assertions fold into the existing `recompute.test.js`, which already tests the schema's consumer.

Net: **8 new files → 4**, against roughly **−220 lines** of `action.yml`.

## Global Constraints

- **No new runtime or test dependencies.** No `package.json` exists. Tests use only `node:test`, `node:assert/strict`, `node:fs`, `node:path`.
- **All third-party actions stay SHA-pinned** with their `# vX.Y.Z` comment (D13).
- **`zizmor` is a hard gate** (`advanced-security: false` — it fails the build on its own exit code). `actionlint` gates workflows only; it does **not** see `ai-review/action.yml`.
- **Composite-action limits (verified):** a step cannot set `timeout-minutes`; there is no `runs:`-level `env:`. Do not use YAML anchors — support in `action.yml` metadata files is unconfirmed.
- **`--json-schema` accepts inline JSON only.** The CLI documents no file-path form. Dedup routes through a step output, not a path argument.
- **Injection safety (ADR 0001 / 0003):** attacker-influenceable content — diff, PR body, linked-issue bodies, model output — is bound via `env:` and read as files. `structured_output` may be tested for emptiness with `[ -z "$VAR" ]`; never echo it into a command.
- **Do not reformat the linked-issue resolver.** `parity.yml` `grep -qF`-checks two exact strings (the `closingIssuesReferences` query and its `jq` transform) in both actions. Whitespace changes break it.
- **Review quality bar is `/requesting-code-review`.** No task may reduce the 8-angle scan, the P0–P3 model, or the `/verification-before-completion` evidence requirement.

---

## Task 1: Structural guard test + single gate step

Lands the guard **first**, so every later YAML move is verifiable without a live run. Then merges `Fork guard` and `Draft/closed gate`, replacing the `is-fork != 'true' && skip != 'true'` prefix repeated on 14 steps.

**Files:**
- Create: `ai-review/lib/action-refs.test.js`
- Modify: `ai-review/action.yml:264-278`, `:319-343`, and every `if:` referencing them
- Modify: `.github/workflows/unit.yml:29`

**Interfaces:**
- Produces: step `id: gate`, outputs `run` (`'true'`/`'false'`), `base-ref`, `head-sha`. All later tasks gate on `steps.gate.outputs.run == 'true'`.

- [ ] **Step 1: Write the guard test**

Create `ai-review/lib/action-refs.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "action.yml"), "utf8");

function declaredIds(text) {
  const ids = [];
  for (const m of text.matchAll(/^\s{4,}id:\s*([A-Za-z0-9_-]+)\s*$/gm)) {
    ids.push(m[1]);
  }
  return ids;
}

function referencedIds(text) {
  const refs = new Map();
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/steps\.([A-Za-z0-9_-]+)\./g)) {
      if (!refs.has(m[1])) refs.set(m[1], []);
      refs.get(m[1]).push(i + 1);
    }
  });
  return refs;
}

test("every steps.<id> reference resolves to a declared step id", () => {
  const declared = new Set(declaredIds(src));
  const dangling = [...referencedIds(src).entries()]
    .filter(([id]) => !declared.has(id))
    .map(([id, lines]) => `${id} (line ${lines.join(", ")})`);
  assert.deepEqual(dangling, [], "dangling step references in action.yml");
});

test("no step id is declared twice", () => {
  const seen = new Set();
  const dupes = declaredIds(src).filter((id) =>
    seen.has(id) ? true : (seen.add(id), false)
  );
  assert.deepEqual(dupes, [], "duplicate step ids in action.yml");
});
```

- [ ] **Step 2: Prove the guard catches the bug**

Temporarily change `id: pr` (line 243) to `id: pr-x`, then run:

```bash
node --test ai-review/lib/action-refs.test.js
```

Expected: FAIL, listing `pr` as dangling with line numbers. **Revert**, re-run, expect PASS.

- [ ] **Step 3: Point unit.yml at the directory**

In `.github/workflows/unit.yml`, replace line 29 `node --test ai-review/lib/recompute.test.js` with:

```yaml
          node --test ai-review/lib/
```

Node auto-discovers `*.test.js`, so no further workflow edits are needed.

- [ ] **Step 4: Replace the two gate steps with one**

Delete `action.yml:264-278` (`Fork guard`) and `:319-343` (`Draft/closed gate`). In place of `Fork guard`:

```yaml
    - name: Gate — fork, draft, and closed PRs
      id: gate
      shell: bash
      env:
        GH_TOKEN: ${{ steps.identity.outputs.author-token }}
        EVENT_NAME: ${{ github.event_name }}
        HEAD_REPO: ${{ github.event.pull_request.head.repo.full_name }}
        BASE_REPO: ${{ github.event.pull_request.base.repo.full_name }}
        PR_NUMBER: ${{ steps.pr.outputs.pr-number }}
        REPO: ${{ github.repository }}
      run: |
        set -euo pipefail
        # A fork PR never reaches the API call below: the head checkout and the
        # App-minted token are both unsafe on attacker-controlled refs, so a
        # maintainer re-runs it via workflow_dispatch instead.
        if [ "${EVENT_NAME}" = "pull_request" ] && [ -n "${HEAD_REPO}" ] \
           && [ -n "${BASE_REPO}" ] && [ "${HEAD_REPO}" != "${BASE_REPO}" ]; then
          echo "::notice::skipped — fork; maintainer can workflow_dispatch"
          echo "run=false" >> "${GITHUB_OUTPUT}"
          exit 0
        fi
        STATE_JSON="$(gh pr view "${PR_NUMBER}" --repo "${REPO}" \
          --json isDraft,state,baseRefName,headRefOid)"
        {
          echo "base-ref=$(echo "${STATE_JSON}" | jq -r '.baseRefName')"
          echo "head-sha=$(echo "${STATE_JSON}" | jq -r '.headRefOid')"
        } >> "${GITHUB_OUTPUT}"
        IS_DRAFT="$(echo "${STATE_JSON}" | jq -r '.isDraft')"
        STATE="$(echo "${STATE_JSON}" | jq -r '.state')"
        if [ "${IS_DRAFT}" = "true" ] || [ "${STATE}" = "CLOSED" ] \
           || [ "${STATE}" = "MERGED" ]; then
          echo "::notice::skipped — PR is draft or closed"
          echo "run=false" >> "${GITHUB_OUTPUT}"
        else
          echo "run=true" >> "${GITHUB_OUTPUT}"
        fi
```

- [ ] **Step 5: Rewrite every dependent reference**

| Old | New |
| --- | --- |
| `steps.fork-guard.outputs.is-fork != 'true' && steps.pr-state.outputs.skip != 'true'` | `steps.gate.outputs.run == 'true'` |
| `steps.pr-state.outputs.base-ref` (`:359`) | `steps.gate.outputs.base-ref` |
| `steps.pr-state.outputs.head-sha` (`:350`, `:516`) | `steps.gate.outputs.head-sha` |

The snapshot step keeps its prefix: `if: always() && steps.gate.outputs.run == 'true'`. The `Clear stale labels` step becomes `steps.gate.outputs.run == 'true' && github.event.action == 'synchronize'` — Task 4 deletes it entirely, so this is transitional.

- [ ] **Step 6: Run the guard**

```bash
node --test ai-review/lib/
```

Expected: PASS. A missed rename surfaces as a dangling `fork-guard`/`pr-state` reference with exact line numbers.

- [ ] **Step 7: Commit**

```bash
git add ai-review/lib/action-refs.test.js ai-review/action.yml .github/workflows/unit.yml
git commit -m "refactor(ai-review): collapse fork and draft gates into one gate output

Adds the only check that covers action.yml's internal consistency:
actionlint does not lint composite action steps."
```

---

## Task 2: Single JSON-schema source of truth

The schema appears verbatim at `:580`, `:730`, `:793`.

**Files:**
- Create: `ai-review/lib/review-schema.json`
- Modify: `ai-review/lib/recompute.test.js` (append three assertions)
- Modify: `ai-review/action.yml` — new `schema` step; lines 580, 730, 793

**Interfaces:**
- Produces: step `id: schema`, output `json` — the schema as one line, consumed by all three `claude-code-action` steps.

- [ ] **Step 1: Append the failing assertions to recompute.test.js**

```js
test("review-schema.json matches what recompute branches on", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const schema = JSON.parse(
    fs.readFileSync(path.join(__dirname, "review-schema.json"), "utf8")
  );
  // recompute() keys off intent === "deviated" and test_execution ===
  // "failed"/"passed". A schema that cannot emit those values silently
  // disables the corresponding gate rule.
  assert.ok(schema.properties.intent.enum.includes("deviated"));
  assert.ok(schema.properties.test_execution.enum.includes("failed"));
  assert.ok(schema.properties.test_execution.enum.includes("passed"));
  assert.deepEqual(Object.keys(schema.properties.counts.properties), [
    "p0",
    "p1",
    "p2",
    "p3",
  ]);
});

test("the schema is not re-inlined in action.yml", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const action = fs.readFileSync(
    path.join(__dirname, "..", "action.yml"),
    "utf8"
  );
  const hits = action.split('"comment_markdown":{"type":"string"}').length - 1;
  assert.equal(hits, 0, "schema JSON was inlined back into action.yml");
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
node --test ai-review/lib/recompute.test.js
```

Expected: FAIL — `ENOENT` on `review-schema.json`.

- [ ] **Step 3: Create the schema file**

Create `ai-review/lib/review-schema.json` from the exact JSON at `action.yml:580`. **Copy it verbatim from that line — do not retype it** — then pretty-print.

- [ ] **Step 4: Add the schema step**

Insert immediately before `Context stage (Haiku)`:

```yaml
    - name: Load the review output schema
      id: schema
      if: steps.gate.outputs.run == 'true'
      shell: bash
      run: |
        set -euo pipefail
        # Single source for all three claude-code-action invocations (review,
        # repair, retry). --json-schema takes inline JSON only — the CLI
        # documents no file-path form — so the file is compacted to one line
        # and passed via a step output. jq -c both validates and compacts: a
        # malformed schema fails here rather than mid-review.
        SCHEMA="$(jq -c . "${GITHUB_ACTION_PATH}/lib/review-schema.json")"
        echo "json=${SCHEMA}" >> "${GITHUB_OUTPUT}"
```

- [ ] **Step 5: Replace all three copies**

At `:580`, `:730`, `:793`, each becomes:

```yaml
          --json-schema '${{ steps.schema.outputs.json }}'
```

- [ ] **Step 6: Run and commit**

```bash
node --test ai-review/lib/
git add ai-review/lib/review-schema.json ai-review/lib/recompute.test.js ai-review/action.yml
git commit -m "refactor(ai-review): single source of truth for the output schema"
```

---

## Task 3: Single retry-gate output

`:755-759` and `:774-778` are byte-identical four-clause conditions, with a comment at `:749-753` warning they "must be kept identical" or the "143ms, \$0.00, never reached the model" bug returns.

**Files:**
- Modify: `ai-review/action.yml` — new `retry-gate` step; `:754-761`, `:771-778`

- [ ] **Step 1: Insert the gate step**

Place **after** `Review stage — structured-output repair`, **before** `Back off before the review retry`:

```yaml
    - name: Decide whether the review needs a full retry
      id: retry-gate
      if: steps.gate.outputs.run == 'true'
      shell: bash
      env:
        # structured_output is model-controlled. Bound via env: and only ever
        # tested for emptiness with -z — never echoed into a command, per
        # ADR 0001/0003 injection safety.
        REVIEW_OUTCOME: ${{ steps.review.outcome }}
        REVIEW_OUT: ${{ steps.review.outputs.structured_output }}
        REPAIR_OUT: ${{ steps.review_repair.outputs.structured_output }}
      run: |
        set -euo pipefail
        NEEDED=false
        if { [ "${REVIEW_OUTCOME}" = "failure" ] || [ -z "${REVIEW_OUT}" ]; } \
           && [ -z "${REPAIR_OUT}" ]; then
          NEEDED=true
        fi
        echo "needed=${NEEDED}" >> "${GITHUB_OUTPUT}"
```

- [ ] **Step 2: Collapse both conditions**

Replace both five-line `if: >-` blocks with:

```yaml
      if: steps.retry-gate.outputs.needed == 'true'
```

- [ ] **Step 3: Replace the drift warning**

The hazard at `:749-753` no longer exists. Replace those lines with:

```yaml
    # The full retry previously fired ~11s after the first attempt ended and
    # was observed returning in 143ms with num_turns 1 and $0.00 cost — it
    # never reached the model. Give a transient upstream/rate-limit condition
    # time to clear before spending another full review. The back-off and the
    # retry share one gate (steps.retry-gate), so the retry can no longer fire
    # without first paying this delay.
```

- [ ] **Step 4: Run and commit**

```bash
node --test ai-review/lib/
git add ai-review/action.yml
git commit -m "refactor(ai-review): compute the retry gate once"
```

---

## Task 4: Delete the stale-label step; reset before the review

`Clear stale labels on new commit` (`:280-317`) duplicates, verbatim, the 24-line label loop in `Reset prior review and labels` (`:965-981`), and only fires on `synchronize`. Reset already clears all four labels unconditionally.

**Files:**
- Modify: `ai-review/action.yml` — delete `:280-317`; relocate `:877-981`

- [ ] **Step 1: Delete the stale-clear step**

Remove `:280-317` in full.

- [ ] **Step 2: Move reset earlier**

Cut `- name: Reset prior review and labels` and paste it immediately **after** the `Gate` step, **before** `Check out PR head`. Its `if:` is already `steps.gate.outputs.run == 'true'`.

- [ ] **Step 3: Document the behavior change**

Prepend to the relocated step:

```yaml
    # Runs BEFORE the review stages, not after: a stale ✓/✗ badge and a
    # superseded review should not sit on the PR for the several minutes a
    # review takes. This also replaces the old synchronize-only
    # "Clear stale labels on new commit" step, whose label loop was a verbatim
    # duplicate of the one below — every event now gets the same treatment.
    # Trade-off: if the job dies mid-review the PR is left unlabelled rather
    # than carrying the previous run's label. That label was stale by
    # definition, and Publish fails closed with an inconclusive
    # REQUEST_CHANGES review, so no failure mode reads as a pass.
```

- [ ] **Step 4: Run and commit**

```bash
node --test ai-review/lib/
git add ai-review/action.yml
git commit -m "refactor(ai-review): clear stale labels once, before the review"
```

---

## Task 5: Extract the Publish step's pure logic to `lib/publish.js`

`Publish review` is 346 lines of inline JavaScript. Roughly 170 are pure functions with no tests — including the over-tick collision guard at `:1238-1248`, the subtlest code in the action. Today the only way to exercise any of it is a live paid Opus review, which is exactly why `recompute.js` was extracted.

**Files:**
- Create: `ai-review/lib/publish.js`
- Create: `ai-review/lib/publish.test.js`
- Modify: `ai-review/action.yml:1025-1046`, `:1140-1176`, `:1211-1322`

**Interfaces:**
- Consumes: the `recompute()` result — `{verdict, confidence, mergeRisk, blockers, counts, intentDeviated}`.
- Produces:
  - `stripLeadingBannerArtifacts(markdown): string`
  - `buildReviewBody({result, modelVerdict, commentMarkdown}): string`
  - `buildInconclusiveBody({salvaged}): string`
  - `normalize(text): string`
  - `tickVerifiedBoxes(body, checklist): {body, ticks}`
  - `buildStatusBlock({checklist, verificationEvidence, verdict}): string`
  - `upsertStatusBlock(body, block): string`

- [ ] **Step 1: Write the failing tests**

Create `ai-review/lib/publish.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  stripLeadingBannerArtifacts,
  buildReviewBody,
  buildInconclusiveBody,
  normalize,
  tickVerifiedBoxes,
  buildStatusBlock,
  upsertStatusBlock,
} = require("./publish.js");

const PASS = {
  verdict: "pass",
  confidence: 95,
  mergeRisk: "low",
  blockers: [],
  counts: { p0: 0, p1: 0, p2: 0, p3: 0 },
  intentDeviated: false,
};

// --- rendering ------------------------------------------------------------

test("strips a leading verdict token the model was told not to emit", () => {
  assert.equal(
    stripLeadingBannerArtifacts("**✅ PASS**\n\n## Findings"),
    "## Findings"
  );
});

test("strips a leading confidence line and HTML marker", () => {
  assert.equal(
    stripLeadingBannerArtifacts(
      "<!-- ai-review -->\nConfidence: 90 · Merge risk: low\n\n## Findings"
    ),
    "## Findings"
  );
});

test("leaves an already-clean body untouched", () => {
  assert.equal(stripLeadingBannerArtifacts("## Findings"), "## Findings");
});

test("body carries the marker, verdict, and counts", () => {
  const body = buildReviewBody({
    result: PASS,
    modelVerdict: "pass",
    commentMarkdown: "## Findings\n\n_None._",
  });
  assert.ok(body.startsWith("<!-- ai-review -->"));
  assert.ok(body.includes("**✅ PASS**"));
  assert.ok(body.includes("Confidence: 95 · Merge risk: low"));
  assert.ok(body.includes("P0: 0 · P1: 0 · P2: 0 · P3: 0"));
});

test("a fail states its own machine reason", () => {
  const body = buildReviewBody({
    result: { ...PASS, verdict: "fail", blockers: ["1 P0 blocker"] },
    modelVerdict: "fail",
    commentMarkdown: "## Findings",
  });
  assert.ok(body.includes("**Why the gate failed:** 1 P0 blocker."));
});

test("a recomputation that overrides the model says so", () => {
  const body = buildReviewBody({
    result: { ...PASS, verdict: "fail", blockers: ["1 P0 blocker"] },
    modelVerdict: "pass",
    commentMarkdown: "x",
  });
  assert.ok(body.includes("overrides the model's self-reported verdict"));
});

test("a pass with nits notes they are non-blocking", () => {
  const body = buildReviewBody({
    result: { ...PASS, counts: { p0: 0, p1: 0, p2: 2, p3: 1 } },
    modelVerdict: "pass",
    commentMarkdown: "x",
  });
  assert.ok(body.includes("2 P2 / 1 P3 finding(s) noted — non-blocking."));
});

test("empty review content still renders a body", () => {
  const body = buildReviewBody({
    result: PASS,
    modelVerdict: "pass",
    commentMarkdown: "",
  });
  assert.ok(body.includes("_No review content returned._"));
});

test("inconclusive body embeds salvaged prose in a details block", () => {
  const body = buildInconclusiveBody({ salvaged: "partial findings" });
  assert.ok(body.startsWith("<!-- ai-review -->"));
  assert.ok(body.includes("inconclusive (re-run required)"));
  assert.ok(body.includes("<details><summary>"));
  assert.ok(body.includes("partial findings"));
});

test("inconclusive body omits the details block when nothing salvaged", () => {
  assert.ok(!buildInconclusiveBody({ salvaged: "" }).includes("<details>"));
});

// --- checklist writeback --------------------------------------------------

test("normalize strips emphasis, case, and trailing punctuation", () => {
  assert.equal(normalize("**Adds `tests`.**"), "adds tests");
  assert.equal(normalize("Adds   tests  "), "adds tests");
});

test("ticks a box whose text matches a verified item", () => {
  const { body, ticks } = tickVerifiedBoxes("- [ ] Adds tests", [
    { text: "Adds tests", status: "verified" },
  ]);
  assert.equal(body, "- [x] Adds tests");
  assert.equal(ticks, 1);
});

test("never unticks a human-checked box", () => {
  const { body, ticks } = tickVerifiedBoxes("- [x] Adds tests", [
    { text: "Adds tests", status: "failed" },
  ]);
  assert.equal(body, "- [x] Adds tests");
  assert.equal(ticks, 0);
});

test("leaves unverified items unticked", () => {
  const { ticks } = tickVerifiedBoxes("- [ ] Adds tests", [
    { text: "Adds tests", status: "unverifiable" },
  ]);
  assert.equal(ticks, 0);
});

test("over-tick guard: one verified item ticks at most one colliding box", () => {
  const { body, ticks } = tickVerifiedBoxes(
    "- [ ] Adds tests\n- [ ] **Adds `tests`.**",
    [{ text: "Adds tests", status: "verified" }]
  );
  assert.equal(ticks, 1, "must not tick both boxes from one verified item");
  assert.equal(body, "- [x] Adds tests\n- [ ] **Adds `tests`.**");
});

test("two verified items with colliding text tick two boxes", () => {
  const { ticks } = tickVerifiedBoxes("- [ ] Adds tests\n- [ ] Adds tests", [
    { text: "Adds tests", status: "verified" },
    { text: "Adds tests", status: "verified" },
  ]);
  assert.equal(ticks, 2);
});

test("handles asterisk bullets and indentation", () => {
  const { body } = tickVerifiedBoxes("  * [ ] Adds tests", [
    { text: "Adds tests", status: "verified" },
  ]);
  assert.equal(body, "  * [x] Adds tests");
});

test("status block renders per-item icons and evidence", () => {
  const block = buildStatusBlock({
    checklist: [
      { text: "Adds tests", status: "verified", evidence: "npm test" },
      { text: "Deploys", status: "unverifiable" },
    ],
    verificationEvidence: [{ command: "npm test", result: "42 passing" }],
    verdict: "pass",
  });
  assert.ok(block.startsWith("<!-- ai-review-status -->"));
  assert.ok(block.endsWith("<!-- /ai-review-status -->"));
  assert.ok(block.includes("- ✅ Adds tests — npm test"));
  assert.ok(block.includes("- ❔ Deploys"));
  assert.ok(block.includes("`npm test` → 42 passing"));
  assert.ok(block.includes("verdict: pass"));
});

test("upsert appends the block when absent", () => {
  const out = upsertStatusBlock(
    "Body text",
    "<!-- ai-review-status -->X<!-- /ai-review-status -->"
  );
  assert.ok(out.startsWith("Body text"));
  assert.ok(out.includes("X"));
});

test("upsert replaces an existing block rather than appending a second", () => {
  const out = upsertStatusBlock(
    "Body\n\n<!-- ai-review-status -->OLD<!-- /ai-review-status -->\n",
    "<!-- ai-review-status -->NEW<!-- /ai-review-status -->"
  );
  assert.ok(out.includes("NEW"));
  assert.ok(!out.includes("OLD"));
  assert.equal(out.split("<!-- ai-review-status -->").length - 1, 1);
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
node --test ai-review/lib/publish.test.js
```

Expected: FAIL — `Cannot find module './publish.js'`.

- [ ] **Step 3: Implement `publish.js`**

Create `ai-review/lib/publish.js`. Move logic **verbatim** from `action.yml` — do not retype:

| Function | Source lines |
| --- | --- |
| `stripLeadingBannerArtifacts` | `:1140-1161` |
| `buildReviewBody` (banner/note assembly + body array) | `:1110-1132`, `:1165-1176` |
| `buildInconclusiveBody` | `:1025-1046` |
| `normalize` (was `norm`) | `:1231-1237` |
| `tickVerifiedBoxes` (verifiedCounts map + ticking loop) | `:1242-1268` |
| `buildStatusBlock` | `:1271-1297` |
| `upsertStatusBlock` | `:1299-1304` |

Preserve the existing explanatory comments — they record why each piece exists (issue #25, the rubric's non-blocking severity rule, the over-tick collision). Export all seven via `module.exports`.

- [ ] **Step 4: Run to verify they pass**

```bash
node --test ai-review/lib/publish.test.js
```

Expected: PASS (20 tests).

- [ ] **Step 5: Wire the action to the module**

Add to the `Publish review` `env:` block, beside `RECOMPUTE_PATH`:

```yaml
        PUBLISH_PATH: ${{ github.action_path }}/lib/publish.js
```

Hoist the import **above** the `try` (`buildInconclusiveBody` is needed inside the `catch`):

```js
          const {
            stripLeadingBannerArtifacts,
            buildReviewBody,
            buildInconclusiveBody,
            tickVerifiedBoxes,
            buildStatusBlock,
            upsertStatusBlock,
          } = require(process.env.PUBLISH_PATH);
```

Replace the checklist block at `:1211-1322` with exactly this. The `try`/`catch`, the `pulls.get` re-fetch immediately before writing (the race guard), the `UPDATE_PR_BODY === "true"` condition, and the `newBody !== originalBody` no-op check all stay in the action — only pure logic moves:

```js
          if (
            process.env.UPDATE_PR_BODY === "true" &&
            Array.isArray(review.checklist) &&
            review.checklist.length > 0
          ) {
            try {
              const { data: prData } = await github.rest.pulls.get({
                owner: context.repo.owner,
                repo: context.repo.repo,
                pull_number: prNumber,
              });
              const originalBody = prData.body || "";

              const { body: tickedBody, ticks } = tickVerifiedBoxes(
                originalBody,
                review.checklist
              );
              const newBody = upsertStatusBlock(
                tickedBody,
                buildStatusBlock({
                  checklist: review.checklist,
                  verificationEvidence,
                  verdict,
                })
              );

              if (newBody !== originalBody) {
                await github.rest.pulls.update({
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  pull_number: prNumber,
                  body: newBody,
                });
                core.info(
                  `Updated PR body (ticked ${ticks} checkbox(es), refreshed status block).`
                );
              } else {
                core.info("PR body already current; no change.");
              }
            } catch (err) {
              core.warning(`Could not update PR body: ${err.message}`);
            }
          }
```

- [ ] **Step 6: Run everything and commit**

```bash
node --test ai-review/lib/
git add ai-review/lib/publish.js ai-review/lib/publish.test.js ai-review/action.yml
git commit -m "refactor(ai-review): extract the Publish step's pure logic to lib/publish.js

Follows the recompute.js precedent: logic that previously could only be
exercised by a live paid Opus review now has 20 unit tests, including the
over-tick collision guard."
```

---

## Verification Before Merge

- [ ] `node --test ai-review/lib/` — all four test files pass
- [ ] `zizmor` passes (hard gate)
- [ ] `actionlint` passes (workflows only — it does not see `ai-review/action.yml`)
- [ ] `parity.yml` passes — the linked-issue GraphQL + jq strings untouched in both actions
- [ ] `selftest.yml` produces a real verdict on the PR carrying these changes, and `gated-demo` runs
- [ ] `ai-review/README.md` pipeline step numbering matches the final step list
- [ ] Final `action.yml` line count recorded against the 1,327 baseline

---

## Decision Gate: the Haiku Context stage

**Not a task. Nothing here is implemented without an explicit ruling.**

`ai-review` makes four LLM calls. The first is the Haiku Context stage (`action.yml:430-487`), which reads the diff and every changed file, greps for callers/callees, and writes `context.md`. With its companion `Verify context.md handoff` (`:489-506`) that is ~90 lines and one full serial LLM call. Composite actions run strictly serially, so its duration is added to every review.

Three sources already call it optional:

- `action.yml:433` — "context.md is a non-essential optimization — the Review stage reads it only 'if present' and works without it."
- `docs/adr/0003:98` — "a best-effort optimization the review reads only 'if present'."
- `ai-review/README.md:67-70` — same framing.

And the Review stage is separately told to re-derive the same material: `:616-623` instructs it to read the diff itself and "Read the COMPLETE contents of every changed file … never sample, truncate, or reason from the diff hunks alone." It holds `Grep` and `Glob` for the cross-file tracing.

**Before ruling, measure:**

```bash
gh run list --workflow=selftest.yml --limit 10 --json databaseId,conclusion,event
gh api "repos/{owner}/{repo}/actions/runs/<RUN_ID>/jobs" \
  --jq '.jobs[] | select(.name|test("review")) | .steps[]
        | {name, started_at, completed_at}'
```

Record durations for `Check out PR head`, `Context stage (Haiku)`, `Review stage (Sonnet/Opus)`, and total job time across three successful runs.

**Options:** (a) delete outright; (b) gate on the existing `sonnet-files-threshold` / `sonnet-churn-threshold` so only large diffs pay for a pre-digest; (c) keep as-is.

**Blast radius of (a)** — every location that must change:

| File | Lines | What is there |
| --- | --- | --- |
| `ai-review/action.yml` | 11 | `description:` — "a Haiku context stage summarizes the diff" |
| `ai-review/action.yml` | 36 | `github-token` description references the Context stage |
| `ai-review/action.yml` | 48 | `allowed-bots` description references the Context stage |
| `ai-review/action.yml` | 130-136 | `haiku-model` input definition |
| `ai-review/action.yml` | 140 | `anthropic-api-key` — "Required for both the Context stage and…" |
| `ai-review/action.yml` | 430-487 | The Context stage step |
| `ai-review/action.yml` | 468 | The only consumer of `inputs.haiku-model` |
| `ai-review/action.yml` | 489-506 | `Verify context.md handoff` step |
| `ai-review/action.yml` | 556, 569 | Review-stage comments referring back to the Context stage |
| `ai-review/action.yml` | 612-614 | Review prompt: "Read `context.md`…" |
| `ai-review/action.yml` | 800 | Retry prompt: "…and `context.md` at the repo root if present" |
| `ai-review/README.md` | 10-11, 65-70 | Two-stage framing + numbered pipeline step 9 |
| `docs/consumer-integration.md` | 64-70 | `timeout-minutes` comment cites the Haiku stage |
| `docs/adr/0003` | 98-106 | The "Context stage is non-fatal" consequence bullet |

`docs/plan.md` (lines 8, 32, 126-129) also mentions it but is a historical record of completed work — **do not edit it.**

**If accepted,** write `docs/adr/0005-context-stage-removal.md` recording the decision (an ADR is warranted once there *is* a decision), work the table row by row, then verify:

```bash
node --test ai-review/lib/    # catches surviving steps.context references
grep -rn "context\.md\|haiku-model\|Context stage" \
  ai-review/ docs/adr/ docs/consumer-integration.md
```

Commit as a breaking change — removing `haiku-model` fails **silently**, since Actions ignores unknown `with:` keys:

```
refactor(ai-review)!: remove the Haiku context stage

BREAKING CHANGE: the haiku-model input is gone. Callers setting it will be
silently ignored by GitHub Actions. See ADR 0005.
```
