# Claude → Cursor → Free Model Cascade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock model IDs inside `ai-review` and `ai-qa` (no model inputs), always prefer Claude, fall back to Cursor only when Claude is blocked, then OpenCode free models, and stamp the model that actually ran plus a re-run hint on every posted review/QA comment.

**Architecture:** Both composite actions keep using `anthropics/claude-code-action` against the caller's Anthropic-compatible gateway. Primaries are hardcoded Claude IDs; Cursor then free IDs are passed as ordered `--fallback-model` lists (CLI overload/block escape hatch). Diff-size Sonnet/Opus routing stays in `ai-review` only. Actual model attribution is read from the stage execution log (`parseExecutionLog`) when present, else the routed primary.

**Tech Stack:** GitHub Actions composite YAML, Node unit tests (`node:test`), existing `ai-review/lib/{publish,metrics,write-manifest}.js`, inline `ai-qa` publish script.

**Spec:** In-chat design (bounded) — cascade Claude → `claude/cursor/...` → `oc/*-free`; models locked at action level; comment shows model + re-review hint. Gateway probe evidence from planning sessions (2026-08-17).

## Global Constraints

- Cascade order is fixed: Claude primary, then Cursor, then free — never Cursor-first, never `auto/*` as primary.
- Model IDs are hardcoded in each action; remove `sonnet-model` / `opus-model` / `haiku-model` / `qa-model` inputs.
- Keep `sonnet-files-threshold` / `sonnet-churn-threshold` inputs on `ai-review`.
- Prefer `claude/` and `claude/cursor/` prefixes (Anthropic Messages–compatible).
- Free tail = **pinned usable `oc/*-free` IDs**, then **`auto/best-free` last** (hybrid). Do not use `auto/*` as Claude or Cursor slots. Do not use `auto/coding:free` (unsupported upstream). Prefer `oc/` over duplicate `opencode/` aliases.
- Shared free tail (all roles): `oc/nemotron-3.5-lightning-free,oc/nemotron-3-ultra-free,oc/deepseek-v4-flash-free,oc/mimo-v2.5-free,oc/laguna-s-2.1-free,auto/best-free`
- `--fallback-model` must not include the primary (CLI no-op otherwise).
- Do not claim `--fallback-model` fixes silent ~27m gateway stalls (ADR 0005).
- Injection safety: bind values via `env:`, never interpolate attacker-controlled text into `run:`/`script:` bodies with `${{ }}`.
- Duplicate the locked ID strings in `ai-review` and `ai-qa` (no shared package) with a one-line "keep in sync" comment.

## Audit (2026-08-17) — gateway + plan review

### What stays correct

- Claude-first cascade matches the product rule; explicit `claude/claude-*` primaries returned HTTP 200 with `model=claude/...`.
- Cursor via `claude/cursor/...` returns proper Anthropic Messages text (required by `claude-code-action`).
- Bare `claude-haiku-4-5` still 401s; dated Haiku primary is mandatory.
- Diff-size routing + locked IDs + comment attribution remain the right shape for both actions.
- No cross-require of `ai-review/lib` from `ai-qa` (separate action package paths).

### `auto/*` combo probes — **reject as Claude/Cursor; allow only as last free hedge**

All 38 `auto/*` IDs are `owned_by: combo`. Probed with `/v1/messages`:

| ID | HTTP | Resolved to | Verdict |
| --- | --- | --- | --- |
| `auto/claude-sonnet` / `auto/claude-opus` | 200 | `cursor/grok-4.5-fast-medium` | **Reject as primary** — not Claude |
| `auto/coding*`, `auto/best-coding*`, … | 200 | Cursor Grok / `cursor/auto` / Codex | Reject for Claude/Cursor slots |
| `auto/coding:free` | 401 | `north-mini-code-free` unsupported | **Reject entirely** |
| `auto/best-free` | 200 | often `cursor/auto` | **OK as final free hedge only** — may re-enter Cursor; still better than failing closed after all pinned free IDs die |

### Free-model inventory (gateway catalog, text only)

Catalog free-ish IDs (excluding video `veo*`):  
`auto/best-free`, `auto/coding:free`, `oc/*-free` ×6, and duplicate `opencode/*-free` ×6 (same backends).

**Re-probe 2026-08-17 (availability + usable text):**

| ID | Result | Pin? |
| --- | --- | --- |
| `oc/nemotron-3.5-lightning-free` | 200, text; `structured_output: true` | **Yes — #1** (best for `--json-schema`) |
| `oc/nemotron-3-ultra-free` | 200, text (earlier 502 once); 1M ctx | **Yes — #2** |
| `oc/deepseek-v4-flash-free` | **429** in probes; `structured_output: true` | **Yes — #3** (skip when rate-limited; strong when available) |
| `oc/mimo-v2.5-free` | 200 earlier; **429** under load | **Yes — #4** |
| `oc/laguna-s-2.1-free` | 200 clean `OK`; `structured_output: false` | **Yes — #5** (last pinned; weaker for schema) |
| `auto/best-free` | 200 | **Yes — #6 last** (combo hedge) |
| `oc/hy3-free` / `opencode/hy3-free` | 200 but **empty text** | No |
| `oc/big-pickle` | catalog present; **not** `*-free`; billing unknown | **No** — do not put in free tail until confirmed free on Eduly |
| `auto/coding:free` | 401 unsupported | No |
| `opencode/*-free` | Same as `oc/` | No — duplicate; prefer `oc/` |
| `veo*` | video | No |

### Plan defects fixed in this revision

1. Free tail was only mimo+laguna — too short under rate limits; expand with both Nemotrons + `auto/best-free` last.
2. Ban `auto/*` for Claude/Cursor slots; allow only `auto/best-free` after pinned free.
3. Prefer free models with `structured_output: true` earlier (review stages use `--json-schema`).
4. Inconclusive review body already says re-run — Task 1 must **not** add a second italic re-run line there (Model line only).
5. Repair/retry inherit the same `--fallback-model` as the review primary; fallback fires per-request on overload, not on silent stalls.

### Locked model map

Shared free tail constant (paste identically everywhere):

```text
FREE=oc/nemotron-3.5-lightning-free,oc/nemotron-3-ultra-free,oc/deepseek-v4-flash-free,oc/mimo-v2.5-free,oc/laguna-s-2.1-free,auto/best-free
```

Do **not** add `oc/big-pickle` while billing is unknown (not labeled free in the catalog). Revisit only after confirming it is zero-cost on the Eduly gateway.
| Action / role | Primary | `--fallback-model` (ordered) |
| --- | --- | --- |
| ai-review context | `claude/claude-haiku-4-5-20251001` | `claude/cursor/composer-2.5,` + FREE |
| ai-review review (tiny) | `claude/claude-sonnet-5` | `claude/cursor/claude-4.6-sonnet-medium-thinking,` + FREE |
| ai-review review (large) | `claude/claude-opus-5` | `claude/cursor/claude-opus-4-8-medium-fast,` + FREE |
| ai-qa review | `claude/claude-sonnet-5` | `claude/cursor/claude-4.6-sonnet-medium-thinking,` + FREE |

Comment footer copy (**successful** reviews / QA comments only):

```text
Model: `<id>`
_Re-run this job if you need another review pass._
```

Inconclusive ai-review bodies: add `Model: \`…\`` when known; keep the existing bold re-run sentence; do not append the italic footer.

---

### Task 1: Publish banner — model + re-review hint (ai-review)

**Files:**
- Modify: `ai-review/lib/publish.js`
- Test: `ai-review/lib/publish.test.js`

**Interfaces:**
- Consumes: existing `buildReviewBody` / `buildInconclusiveBody` call sites
- Produces: `buildReviewBody({ …, modelUsed?: string|null })`, `buildInconclusiveBody(salvaged, { modelUsed?: string|null })` — when `modelUsed` is a non-empty string, bodies include `Model: \`…\`` and the re-run hint line

- [ ] **Step 1: Write the failing tests**

Add to `ai-review/lib/publish.test.js`:

```js
test("buildReviewBody includes model used and re-review hint", () => {
  const body = buildReviewBody({
    ...BASE_ARGS,
    modelUsed: "claude/claude-sonnet-5",
  });
  assert.match(body, /Model: `claude\/claude-sonnet-5`/);
  assert.match(body, /Re-run this job if you need another review pass/);
});

test("buildReviewBody omits Model line when modelUsed is empty", () => {
  const body = buildReviewBody({ ...BASE_ARGS, modelUsed: "" });
  assert.doesNotMatch(body, /^Model:/m);
});

test("buildInconclusiveBody includes Model line but not a second italic re-run hint", () => {
  const body = buildInconclusiveBody("salvaged text", {
    modelUsed: "claude/cursor/composer-2.5",
  });
  assert.match(body, /Model: `claude\/cursor\/composer-2.5`/);
  assert.match(body, /\*\*Re-run the `ai-review` job\*\*/);
  assert.doesNotMatch(body, /_Re-run this job if you need another review pass\._/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test ai-review/lib/publish.test.js`

Expected: FAIL — `modelUsed` not in builders / no Model line.

- [ ] **Step 3: Minimal implementation in `publish.js`**

```js
function modelLine(modelUsed) {
  if (!modelUsed || typeof modelUsed !== "string" || !modelUsed.trim()) return [];
  return ["", `Model: \`${modelUsed.trim()}\``];
}

function modelFooter(modelUsed) {
  const line = modelLine(modelUsed);
  if (!line.length) return [];
  return [...line, "_Re-run this job if you need another review pass._"];
}
```

- `buildReviewBody`: after confidence/counts, append `...modelFooter(modelUsed)` before `commentBody`.
- `buildInconclusiveBody(salvaged, opts = {})`: after the existing bold re-run sentence, append `...modelLine(opts.modelUsed)` only (no italic footer).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test ai-review/lib/publish.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ai-review/lib/publish.js ai-review/lib/publish.test.js
git commit -m "$(cat <<'EOF'
feat(ai-review): show model used and re-run hint on review comments

EOF
)"
```

---

### Task 2: Resolve actual model from execution logs (ai-review)

**Files:**
- Modify: `ai-review/lib/metrics.js` (export a tiny helper if needed)
- Modify: `ai-review/action.yml` (Publish step env + script)
- Test: `ai-review/lib/metrics.test.js`

**Interfaces:**
- Consumes: `parseExecutionLog(entries)` → `{ model }`
- Produces: `resolveModelUsed({ logs: unknown[], fallback: string }) → string` — first non-null `model` from parsed logs in order, else `fallback`

- [ ] **Step 1: Write the failing test**

```js
const { resolveModelUsed, parseExecutionLog } = require("./metrics.js");

test("resolveModelUsed prefers first log that names a model", () => {
  const retry = [{ type: "system", subtype: "init", model: "oc/mimo-v2.5-free" }, { type: "result", subtype: "success", num_turns: 1, total_cost_usd: 0, duration_ms: 10 }];
  const review = [{ type: "system", subtype: "init", model: "claude/claude-opus-5" }, { type: "result", subtype: "success", num_turns: 1, total_cost_usd: 0, duration_ms: 10 }];
  assert.equal(
    resolveModelUsed({ logs: [retry, review], fallback: "claude/claude-opus-5" }),
    "oc/mimo-v2.5-free",
  );
});

test("resolveModelUsed falls back when logs empty", () => {
  assert.equal(resolveModelUsed({ logs: [null, []], fallback: "claude/claude-sonnet-5" }), "claude/claude-sonnet-5");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ai-review/lib/metrics.test.js`

Expected: FAIL — `resolveModelUsed` not exported.

- [ ] **Step 3: Implement `resolveModelUsed` in `metrics.js` and export it**

```js
function resolveModelUsed({ logs, fallback }) {
  for (const log of logs || []) {
    const m = parseExecutionLog(log).model;
    if (typeof m === "string" && m.trim()) return m.trim();
  }
  return typeof fallback === "string" ? fallback : "";
}
```

- [ ] **Step 4: Wire Publish in `action.yml`**

Before `buildReviewBody` / `buildInconclusiveBody` calls, read snapshots (same paths telemetry uses):

- `${runner.temp}/ai-review-exec-review-snapshot.json`
- `${runner.temp}/ai-review-exec-repair-snapshot.json`
- `steps.review_retry.outputs.execution_file` (via env)

Pass into Publish `env:`:

```yaml
ROUTED_MODEL: ${{ steps.route.outputs.model }}
REVIEW_LOG: ${{ runner.temp }}/ai-review-exec-review-snapshot.json
REPAIR_LOG: ${{ runner.temp }}/ai-review-exec-repair-snapshot.json
RETRY_LOG: ${{ steps.review_retry.outputs.execution_file }}
METRICS_PATH: ${{ github.action_path }}/lib/metrics.js
```

In the Publish script (prefer retry → repair → review):

```js
const { resolveModelUsed } = require(process.env.METRICS_PATH);
const read = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const modelUsed = resolveModelUsed({
  logs: [read(process.env.RETRY_LOG), read(process.env.REPAIR_LOG), read(process.env.REVIEW_LOG)],
  fallback: process.env.ROUTED_MODEL || "",
});
```

Pass `modelUsed` into both body builders.

- [ ] **Step 5: Run metrics + publish tests**

Run: `node --test ai-review/lib/metrics.test.js ai-review/lib/publish.test.js`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add ai-review/lib/metrics.js ai-review/lib/metrics.test.js ai-review/action.yml
git commit -m "$(cat <<'EOF'
feat(ai-review): attribute PR review to the model that actually ran

EOF
)"
```

---

### Task 3: Lock ai-review models + Claude→Cursor→free fallbacks

**Files:**
- Modify: `ai-review/action.yml`
- Modify: `ai-review/lib/write-manifest.js`
- Modify: `ai-review/README.md`
- Test: `ai-review/lib/roster.test.js` (only if defaults asserted — update expected IDs)

**Interfaces:**
- Consumes: Global Constraints model map
- Produces: `steps.route.outputs.model`, `steps.route.outputs.fallback-model`; Context uses Haiku primary + Haiku fallback list

- [ ] **Step 1: Remove model inputs**

Delete `sonnet-model`, `opus-model`, and `haiku-model` from `ai-review/action.yml` `inputs:`.

- [ ] **Step 2: Hardcode routing env and emit fallback list**

In **Deterministic prep and model routing**, replace `inputs.*-model` with:

```bash
# Locked at action level — keep in sync with ai-qa cascade comments.
SONNET="claude/claude-sonnet-5"
OPUS="claude/claude-opus-5"
HAIKU="claude/claude-haiku-4-5-20251001"
SONNET_FALLBACK="claude/cursor/claude-4.6-sonnet-medium-thinking,oc/nemotron-3.5-lightning-free,oc/nemotron-3-ultra-free,oc/deepseek-v4-flash-free,oc/mimo-v2.5-free,oc/laguna-s-2.1-free,auto/best-free"
OPUS_FALLBACK="claude/cursor/claude-opus-4-8-medium-fast,oc/nemotron-3.5-lightning-free,oc/nemotron-3-ultra-free,oc/deepseek-v4-flash-free,oc/mimo-v2.5-free,oc/laguna-s-2.1-free,auto/best-free"
HAIKU_FALLBACK="claude/cursor/composer-2.5,oc/nemotron-3.5-lightning-free,oc/nemotron-3-ultra-free,oc/deepseek-v4-flash-free,oc/mimo-v2.5-free,oc/laguna-s-2.1-free,auto/best-free"
```

Export `HAIKU` / `OPUS` / `SONNET` to the environment for `write-manifest.js` (same as today). After choosing `MODEL`, also set `FALLBACK` to the matching list and write:

```bash
echo "model=${MODEL}" >> "${GITHUB_OUTPUT}"
echo "fallback-model=${FALLBACK}" >> "${GITHUB_OUTPUT}"
echo "haiku-model=${HAIKU}" >> "${GITHUB_OUTPUT}"
echo "haiku-fallback-model=${HAIKU_FALLBACK}" >> "${GITHUB_OUTPUT}"
```

- [ ] **Step 3: Wire `--fallback-model` on every Claude stage**

Context:

```yaml
--model ${{ steps.route.outputs.haiku-model }}
--fallback-model ${{ steps.route.outputs.haiku-fallback-model }}
```

Review / Repair / Retry:

```yaml
--model ${{ steps.route.outputs.model }}
--fallback-model ${{ steps.route.outputs.fallback-model }}
```

Update step comments: cascade is Claude → Cursor → free; do not reintroduce Anthropic-only fallbacks like `claude-sonnet-4-6,claude-opus-4-8`.

- [ ] **Step 4: Align `write-manifest.js` defaults**

```js
opus: process.env.OPUS || "claude/claude-opus-5",
sonnet: process.env.SONNET || "claude/claude-sonnet-5",
haiku: process.env.HAIKU || "claude/claude-haiku-4-5-20251001",
```

Update any roster tests that assert the old bare IDs.

- [ ] **Step 5: Update `ai-review/README.md`**

Remove the three model input rows. Document locked cascade and that the PR review footer shows the model that ran.

- [ ] **Step 6: Run unit tests**

Run: `node --test ai-review/lib/*.test.js`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add ai-review/action.yml ai-review/lib/write-manifest.js ai-review/README.md ai-review/lib/roster.test.js
git commit -m "$(cat <<'EOF'
feat(ai-review): lock Claude primaries with Cursor then free fallbacks

EOF
)"
```

---

### Task 4: Lock ai-qa model + same cascade + comment footer

**Files:**
- Modify: `ai-qa/action.yml`
- Modify: `ai-qa/README.md`
- Create: `ai-qa/lib/report-footer.js`
- Create: `ai-qa/lib/report-footer.test.js`

**Interfaces:**
- Consumes: Global Constraints ai-qa row
- Produces: `formatModelFooter(modelUsed) → string` (empty string if no model); QA comment includes footer; primary `claude/claude-sonnet-5` with Cursor+free fallbacks

- [ ] **Step 1: Write failing tests for footer helper**

```js
// ai-qa/lib/report-footer.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { formatModelFooter } = require("./report-footer.js");

test("formatModelFooter renders model and re-run hint", () => {
  const s = formatModelFooter("claude/claude-sonnet-5");
  assert.match(s, /Model: `claude\/claude-sonnet-5`/);
  assert.match(s, /Re-run this job if you need another review pass/);
});

test("formatModelFooter returns empty for blank", () => {
  assert.equal(formatModelFooter(""), "");
  assert.equal(formatModelFooter(null), "");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ai-qa/lib/report-footer.test.js`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `ai-qa/lib/report-footer.js`**

```js
"use strict";

function formatModelFooter(modelUsed) {
  if (!modelUsed || typeof modelUsed !== "string" || !modelUsed.trim()) return "";
  return [
    `Model: \`${modelUsed.trim()}\``,
    "_Re-run this job if you need another review pass._",
  ].join("\n");
}

module.exports = { formatModelFooter };
```

- [ ] **Step 4: Remove `qa-model` input; hardcode Claude + fallbacks**

In `ai-qa/action.yml`, delete `qa-model`. Replace review `claude_args` model lines with:

```yaml
# Locked at action level — keep in sync with ai-review cascade.
# Claude primary → Cursor if Claude blocked → free if Cursor blocked.
--model claude/claude-sonnet-5
--fallback-model claude/cursor/claude-4.6-sonnet-medium-thinking,oc/nemotron-3.5-lightning-free,oc/nemotron-3-ultra-free,oc/deepseek-v4-flash-free,oc/mimo-v2.5-free,oc/laguna-s-2.1-free,auto/best-free
```

Update the comment that currently describes `claude-sonnet-4-6,claude-opus-4-8`.

- [ ] **Step 5: Attribute model in the report comment step**

After the QA review step, add a small best-effort step (or inline in Publish) that reads `${{ steps.review.outputs.execution_file }}`, parses JSON, and sets `model-used` output using the same init-entry rule as `parseExecutionLog` (duplicate 10 lines in bash/`github-script`, or require a copy of `resolveModelUsed` — prefer requiring `../../ai-review/lib/metrics.js` **only if** path from `github.action_path` is reliable when `ai-qa` is the entry action; it is NOT — consumers call `…/ai-qa@main`, so `ai-review/lib` is not on the action path).

**Do not cross-require ai-review from ai-qa.** Duplicate a minimal model extractor in `ai-qa/lib/report-footer.js`:

```js
function modelFromExecutionLog(entries) {
  if (!Array.isArray(entries)) return "";
  for (const e of entries) {
    if (e && typeof e.model === "string" && e.model.trim()) return e.model.trim();
  }
  return "";
}
```

In the Publish `github-script`, read `process.env.REVIEW_EXEC_FILE`, parse, `modelFromExecutionLog`, fallback `"claude/claude-sonnet-5"`, then `body.push(formatModelFooter(modelUsed))` before the `_Posted by…_` line.

- [ ] **Step 6: Update `ai-qa/README.md`**

Remove `qa-model` row; document locked cascade and comment Model line.

- [ ] **Step 7: Run tests**

Run: `node --test ai-qa/lib/report-footer.test.js`

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add ai-qa/action.yml ai-qa/README.md ai-qa/lib/report-footer.js ai-qa/lib/report-footer.test.js
git commit -m "$(cat <<'EOF'
feat(ai-qa): lock Claude primary with Cursor then free fallbacks

EOF
)"
```

---

### Task 5: Docs / consumer notes sanity

**Files:**
- Modify: `docs/consumer-integration.md` only if it mentions overridable model inputs
- Modify: `docs/plan.md` model-ID bullet if it still says repo-var overridable models for these actions

- [ ] **Step 1: Grep for stale model-input docs**

Run: `rg -n 'sonnet-model|opus-model|haiku-model|qa-model|repo-var overridable' docs ai-review ai-qa`

- [ ] **Step 2: Patch any consumer-facing mentions to “locked in the action; Claude → Cursor → free”**

- [ ] **Step 3: Commit if anything changed**

```bash
git add docs/
git commit -m "$(cat <<'EOF'
docs: note locked Claude→Cursor→free model cascade

EOF
)"
```

---

## Self-review

1. **Spec coverage:** Lock models — Tasks 3–4. Cascade Claude→Cursor→free — Tasks 3–4. Comment model + re-run hint — Tasks 1–2, 4. ai-qa included — Task 4. `auto/*` ban + free-tail hardening — Audit + Global Constraints.
2. **Placeholders:** None intentionally left.
3. **Type consistency:** `modelUsed` string; `resolveModelUsed({ logs, fallback })`; `formatModelFooter(modelUsed)`; `modelLine` / `modelFooter` in publish.
4. **Stall caveat:** Documented; not “fixed” by this plan.
5. **auto/* audit:** Ban as Claude/Cursor; allow only `auto/best-free` after pinned free. Free pin order prefers `structured_output` then resilience then combo hedge.
