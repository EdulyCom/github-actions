# AI Review Rubric

The review rubric applied by the review stage: code quality → correctness → security → tests → performance.

---

## Finding Methodology — 8-Angle Code Scan

Run this scan as the core of the review **before** classifying into the checklist.
A checklist pass alone misses bugs in unchanged lines of a touched function, invariants
broken by deleted code, and callers broken by a changed signature. The structured scan
finds those.

**Independence rule:** treat each angle as a fresh, isolated scan of the diff. Do not
let findings from one angle steer the next — cross-contamination rationalizes bugs away
before they reach the verify step.

### The 8 Angles

**H — Intent alignment** *(run first — sets the frame for all subsequent angles)*

Read `.ai-review/linked-issues.json` (repository root) — a deterministic
earlier step resolved every issue this PR closes (closing keywords AND GitHub's
linked-issue graph) into an array of `{number,title,body,state,url,labels}`. Read
the PR body via `gh pr view "$PR_NUMBER" --json title,body,url,number`. Together
these establish the **stated goal**: what was this change supposed to do? (If
`.ai-review/linked-issues.json` is absent or `[]`, use the PR title/body alone;
`gh issue view <n>` is available if you need more detail on a linked issue.)

Extract acceptance criteria in this priority order:
1. Explicit Test Plan / checklist items (`- [ ]` / `- [x]`) in a linked issue or the PR body
   (Prep may also stage them in `.ai-review/test-plan-items.json`)
2. Numbered requirements or "must/should" statements
3. Inferred intent from title + description narrative

For Test Plan items specifically, also read `.ai-review/ci-checks.json` when present:
uncovered or weakly covered items are findings (P0–P3), not PR-body ticks.

Compare against the diff:

| Signal | Finding | Severity |
|--------|---------|----------|
| Diff implements something that doesn't address the stated goal, or moves in a different direction | **Wrong solution** — quote the goal and the divergence | **P0** |
| A clearly stated AC or requirement has no corresponding implementation | **Missing requirement** — name the AC | **P1** |
| Diff implements significantly more than what was asked | **Scope creep** — flag what's extra | **P2** |
| PR body and linked issue together are too thin to establish intent (present but vague) | Note `"intent alignment: insufficient spec context"` | No finding |

**Skip conditions — two hard triggers only (no finding):**
- `.ai-review/linked-issues.json` is `[]` AND PR body and title together are under 50 words → `"intent alignment skipped — insufficient context"`
- PR title starts with `chore:`, `docs:`, or `style:` AND diff contains no functional code changes → `"intent alignment skipped — non-functional PR type"`

Everything else: run Angle H, even if intent must be inferred from narrative.
Do NOT claim "no structured requirements" as a skip reason — infer from description.

**VIOLATION: Running A–G before H** defeats the frame-setting purpose. Code findings
discovered first create confirmation bias — you assess intent through the lens of what
the code *does*, not what it was *supposed* to do. Run H cold, on spec text alone,
before reading any diff analysis from other angles.

**Hard rule — independence:** Do not read any diff hunk, angle output, or code finding
before completing Angle H. If you have already read the diff for other purposes, derive
your Angle H verdict from spec text alone — explicitly ignoring what you saw in the diff.
Running H *after* reading the diff does not count as running H first, even if you
re-derive intent from scratch.

**Rationalizations that violate this rule:**

| You might think | Why it's wrong |
|---|---|
| "I naturally read the diff when loading it, so H already ran" | H means: derive intent from spec text ONLY, before touching diff analysis |
| "H and A run in the same context window — order is a convention" | Order matters: intent derived after seeing code is post-hoc rationalization, not frame-setting |
| "The issue has no checklist so I'll call it insufficient context" | Insufficient context ≠ no context. Infer from title + narrative before skipping |

**Candidate limit:** up to 4 candidates from Angle H.

---

**A — Line-by-line diff scan**
Read every hunk, then read the enclosing function for each hunk — bugs in _unchanged_
lines of a touched function are in scope. For every changed line: what input, state,
timing, or platform makes this wrong? Look for: inverted/wrong conditions, off-by-one,
null/undefined deref, missing `await`, falsy-zero treated as missing, wrong-variable
copy-paste, error swallowed in catch, unescaped regex metacharacters.

**B — Removed-behavior auditor**
For every line the diff **deletes or replaces**, name the invariant or behavior it
enforced, then search the new code for where that invariant is re-established. If it
can't be found: removed guard, dropped error path, narrowed validation, deleted test.

**C — Cross-file tracer**
For each function the diff changes, Grep for its callers and check whether the change
breaks any call site: new precondition, changed return shape, new exception,
timing/ordering dependency. Check callees too — does a parallel change in the same PR
make a call unsafe? This is the one angle with no natural stopping point — bound it by
risk, not by exhaustiveness: prioritize call sites on security/auth paths, data
mutation, and public API surface. A Grep match is enough to clear a call site whose
usage is unambiguous from the match itself (e.g. a simple pass-through); spend a full
`Read` only where the call site's correctness genuinely can't be judged from the match.
Prefer hunks + targeted Grep over opening every changed file end-to-end; expand to a
full `Read` when the diff alone cannot support a judgment (large renames, tangled
control flow, security-sensitive paths).

**D — Reuse**
Flag new code that re-implements something the codebase already has. Grep adjacent files
and shared libraries — name the existing helper to call instead.

**E — Simplification**
Flag unnecessary complexity the diff adds: redundant or derivable state, copy-paste
with slight variation, deep nesting, dead code left behind.

**F — Efficiency**
Flag wasted work the diff introduces: N+1 queries, repeated DB/network calls, missing
pagination on unbounded lists, independent operations run sequentially, blocking work
added to a request handler.

**G — Altitude**
Check that each change is implemented at the right depth, not as a fragile bandaid.
Special cases layered on shared infrastructure signal the fix isn't deep enough.

---

### Candidate Collection

Each angle surfaces **up to 6 candidates** per pass with: `file`, `line`, one-line
`summary`, and a concrete `failure_scenario`. (Angle H limit: up to 4 candidates — intent
issues are high-signal; more than 4 suggests the spec was too vague to assess reliably.)

**Pass every candidate with a nameable failure scenario through.** Silently dropping
half-believed candidates bypasses the verify step and is the dominant cause of misses.
Correctness bugs (A/B/C) always outrank cleanup/altitude (D/E/F/G) when forced to cut.

### Verify Pass (recall-biased)

De-dup near-duplicates (same defect, same location, same reason → keep one). For each
remaining candidate, verify it — err toward surfacing:

| Verdict       | When to use |
|---|---|
| **CONFIRMED** | Clearly a real issue |
| **PLAUSIBLE** | _Default_ — when state is realistic: concurrency race, nil on a rare-but-reachable path, falsy-zero treated as missing, off-by-one on a boundary the code does not exclude. Do NOT refute for being "speculative." |
| **REFUTED**   | _Only_ when constructible from code: factually wrong (quote the actual line), provably impossible (show the type/constant/invariant), already handled in this diff (cite the guard), or pure style with zero observable effect |

Keep **CONFIRMED** and **PLAUSIBLE**. Drop **REFUTED**.

---

## Severity Levels

### P0 — Blocker
Merge must be blocked. Breaks functionality, violates security, or corrupts data.

Examples: SQL injection, XSS, missing auth/authz, data loss, breaking API change without
migration, committed secret, CI required check failing.

### P1 — Should Fix
Fix before merge, or document explicitly.

Examples: N+1 queries, missing error handling on external calls, unsafe type casts,
hardcoded credentials, missing auth on a protected route, missing pagination on an
unbounded list.

### P2 — Nice-to-Have
Can merge with note; fix in follow-up.

Examples: unclear variable names, suboptimal performance on cold paths, incomplete
non-critical test coverage, missing JSDoc on a reusable utility.

### P3 — Nit
Optional improvements.

Examples: formatting preference, typo in comment, minor refactoring opportunity.

---

## Comprehensive Review Checklist

### 1. PR Description & Metadata

- [ ] Title follows Conventional Commits (`feat:`, `fix:`, `chore:`, etc.). Failing
  commitlint CI check → auto-P0.
- [ ] Description explains the WHY, not just the WHAT.
- [ ] Breaking changes called out explicitly.
- [ ] `Closes #NNN` link present when the PR closes an issue.
- [ ] If a linked issue or the PR description has a Test Plan / checklist,
  map each item to CI coverage using `.ai-review/test-plan-items.json` and
  `.ai-review/ci-checks.json` when present. Uncovered or only weakly covered
  items become normal `findings[]` entries with severity P0–P3 via this
  rubric (model-judged; do not floor all gaps at P1). Leave the structured
  `checklist` array empty — Publish no longer ticks PR-body boxes. Never
  invent CI coverage; manual/post-merge items with no plausible check mapping
  may be omitted or filed at low severity. Do NOT fail the review solely
  because a human left boxes unchecked.

### 2. Merge Conflict Handling

- [ ] If `mergeable == CONFLICTING`: review both branches' business logic; confirm intent
  from both sides is preserved. Unclear resolution → P1.

### 3. Code Quality

**Type safety (all languages)**

- [ ] No `any` / `object` / `unknown` type widening without a justifying comment — P1 in
  production code, P2 in specs.
- [ ] No `@ts-ignore` / `// eslint-disable` without a one-line reason — P1.
- [ ] No non-null assertions (`!`) that are demonstrably unsafe.
- [ ] Python: no `Any` annotations without a justifying comment; `mypy --strict` flags
  honored.

**Naming conventions**

- [ ] Variable/function names are clear; no cryptic abbreviations or single-letter vars
  except iterators.
- [ ] Boolean names prefixed with `is`, `has`, `should`, `can`.
- [ ] Constants in `SCREAMING_SNAKE`; types/classes in `PascalCase`.

**Code style**

- [ ] Linter/formatter check from the project's CI gate is green (derive the command
  from `package.json` scripts or CI config — do not hardcode it).

### 4. Project-Specific Dimensions (Profile Seam)

Run the universal scan above (angles A–G + sections 3, 5–14).

**If a project review profile exists at `${user_config.REVIEW_PROFILE_PATH}` (default
`.claude/review-profile.md`), load it now and apply its additional dimensions on top.**
A profile typically provides: stack-specific file-path patterns to Grep, banned-import
rules, ADR references, auth/permission decorator names, and domain-invariant rules
(e.g. multi-tenancy scoping requirements).

If the profile is absent, the universal scan stands alone — no product-specific rules
are applied.

### 5. Maintainability

- [ ] Code is self-documenting; complex logic has comments explaining WHY, not WHAT.
- [ ] Functions have single responsibility; avoid deeply nested callbacks (prefer
  async/await).
- [ ] No premature abstractions (rule: 3+ uses before extracting).
- [ ] Grep for similar code before writing new — name any existing helper.

### 6. Reliability

- [ ] Handles empty arrays, null/undefined, invalid inputs gracefully.
- [ ] No unhandled promise rejections or floating promises.
- [ ] Retry logic with backoff for external API calls.
- [ ] State invariants are preserved; race conditions considered (optimistic locking,
  `SELECT FOR UPDATE`, or equivalent).
- [ ] Idempotency where applicable (webhooks, queued jobs, retries).

### 7. Backend Patterns

- [ ] Controller/handler methods are thin — delegate to services/use-cases.
- [ ] Business logic lives in services, not in controllers or route handlers.
- [ ] Dependencies are injected (constructor or framework DI), not instantiated inline.
- [ ] DTOs/schemas validate all request data at the boundary.
- [ ] Sensitive fields excluded from API responses.
- [ ] List endpoints paginated (`limit`/`cursor`/`offset`) — missing pagination on a
  DB-backed list → P1.

### 8. Frontend Patterns

- [ ] No unnecessary re-renders (check for missing `key` props in lists, inefficient
  deps in `useMemo`/`useEffect`).
- [ ] Data fetching separated from presentation.
- [ ] Form inputs have accessible labels; form errors displayed near the relevant field.
- [ ] Loading and error states handled for asynchronous data.

### 9. Database Changes

- [ ] Schema changes are backwards compatible, or a migration strategy is documented.
- [ ] Required fields have defaults or are explicitly nullable.
- [ ] Indexes added for columns used in `WHERE` / `ORDER BY` on high-volume tables.
- [ ] Relations have an explicit cascade strategy.
- [ ] Migration file present (if schema changed); migration replays cleanly from empty DB.
- [ ] No N+1 queries (loops around DB calls → batch / join / dataloader).

### 10. Security

- [ ] No SQL/NoSQL injection: use parameterized queries or the ORM's query builder.
- [ ] No `dangerouslySetInnerHTML` without sanitization; no XSS vectors.
- [ ] Auth/authz enforced on every endpoint — missing protection → P0.
- [ ] Multi-tenant queries scope data to the authenticated user's tenant.
- [ ] Passwords hashed (bcrypt/argon2), never stored plaintext; tokens have short expiry.
- [ ] API keys, tokens, and credentials never logged or included in error responses.
- [ ] All external inputs validated: user input, query params, file uploads (size/type).
- [ ] Webhook receivers verify HMAC/signature before parsing.

Flag security issues as **P0** (vulnerability) or **P1** (weak-but-not-broken control).

### 11. Business Logic

- [ ] Domain rules implemented correctly per the issue/ticket description.
- [ ] State transitions valid; impossible states are rejected.
- [ ] Calculations correct; no float arithmetic on monetary values.
- [ ] All paths covered: happy path, error paths, edge cases (zero-length arrays, null
  references, boundary values).

Flag as P0 (breaks feature) or P1 (incorrect behavior).

### 12. Testing

**Test Plan ↔ CI (do not tick PR checklists):** Prep writes
`.ai-review/test-plan-items.json` and `.ai-review/ci-checks.json`. Map each
Test Plan item to inventoried checks. Gaps (uncovered / weakly covered) are
normal findings with P0–P3 severity per this rubric. Leave `checklist` empty —
Publish does not tick PR-body boxes. Still report `test_execution: "skipped"`;
do not run tests.

**Coverage expectations** (flag misses at the severity shown):

| Scope | Minimum | Flag as |
|---|---|---|
| Critical paths (auth, payments, data mutations) | ≥ 80% | P1 if short |
| Services / business logic | ≥ 70% | P2 if short |
| Utilities / helpers | ≥ 60% | P3 if short |
| Coverage delta | ≥ 0 (no regression) | P2 if regresses |

**Test requirement matrix (by change type)**

| Change Type | Unit | Integration | E2E |
|---|---|---|---|
| Feature | ✅ Required | ✅ Required (with real DB) | ✅ Critical flows |
| Bug Fix | ✅ Regression test | ✅ If DB-touching | ⚠️ If user-facing |
| Refactor | ✅ Existing pass unchanged | ✅ If DB-touching | ⚠️ If UI-heavy |
| Security Fix | ✅ Security-specific | ✅ If auth/data-related | ✅ If attack surface |
| Performance | ⚠️ Benchmark if possible | ✅ If query-heavy | ⚠️ If UX-impacting |
| Docs/Config | — | — | — |

**Test execution: do NOT run tests.** Report `test_execution: "skipped"` and spend no
turns looking for a toolchain or package manager. The review session no longer
allowlists `npm`/`npx`/`pnpm`/`yarn`/`pytest`/`make`/`node`, so no attempt can succeed.

This is not a gap in the review. Running the suite was never this stage's job — the
caller's own CI lanes run the tests downstream of this gate, sharded and
coverage-enforced, and a failing suite blocks the merge there. Removing the runners
from the allowlist also closes a code-execution path: this stage is checked out at the
**PR head commit**, so shell access to a package manager meant PR-authored scripts
could execute on the runner.

Assess test *quality* statically, as below. That judgment comes from reading the diff
and the repo's existing test files, it still blocks the gate, and it is the part of
"testing" this review is actually good at.

**Test gap identification (from the diff):**

- New functions/methods added → unit test needed
- DB queries modified → integration test needed
- Auth/permissions changed → RBAC test needed (P1 critical)
- User-facing flows modified → E2E test needed
- Security-sensitive code touched → security test needed (P1 critical)

### 13. Internationalization (i18n)

- [ ] No hardcoded user-visible strings in frontend/mobile code — P1.
- [ ] Plural forms and interpolation for dynamic content handled.
- [ ] Date/number formatting uses locale-aware APIs.
- [ ] RTL: `start`/`end` layout props, not `left`/`right`; directional icons mirrored.

### 14. Performance

- [ ] No N+1 queries (flag every loop around a DB call — use batch/join).
- [ ] Pagination on every list endpoint that could grow unboundedly — P1 if missing.
- [ ] No blocking synchronous I/O in request handlers; long tasks offloaded to a queue.
- [ ] No unnecessary re-renders (frontend) or repeated expensive computations without
  caching.

---

## Confidence Rate Calculation

```
confidence = 100 − (P0_count × 30) − (P1_count × 15) − (P2_count × 5)
```

Clamp to [0, 100].

**Adjust for test quality:**
- Tests present AND passing AND coverage ≥ targets: no adjustment (or +3 at discretion).
- Tests failing: −10 minimum.
- Coverage < 60% on critical paths: −5.
- No tests at all for changed logic: −15. **Exemption:** this penalty applies only
  when §12's test requirement matrix expects tests for the change type (Feature, Bug
  Fix, Refactor, Security Fix, Performance). A **Docs/Config**-only diff (the matrix's
  `—`/`—`/`—` row — CI/workflow YAML, composite action wiring, markdown, prompt text,
  other non-unit-testable config) has no test-eligible surface and is exempt: report
  `no_tests_for_changed_logic = false` for it, not `true`. Don't conflate "no tests
  exist because none are needed" with "no tests exist because they were skipped."
- Test execution **skipped** (no toolchain available — this action provisions
  none, per ADR 0003 §2) or **not run** (nothing testable in the diff): **no
  adjustment**. The sandbox is not the test oracle; the authoritative signal is
  the caller's own CI lanes. Do not penalize the review for an environment
  limitation.

| Confidence | Label |
|---|---|
| ≥ 85% | High — ready to merge (with threshold check) |
| 70–84% | Medium — minor issues documented |
| 50–69% | Low — P1s requiring fix |
| < 50% | Very Low — P0s found or major gaps |

**Pass threshold.** The gate compares a **blocking-finding confidence** — the
same formula with the **P2 term removed** — against
`${user_config.AI_REVIEW_CONFIDENCE_THRESHOLD}` (default **90**):

```
gate_confidence = 100 − (P0_count × 30) − (P1_count × 15) + test_adjustment
pass = gate_confidence ≥ threshold AND P0_count == 0 AND P1_count == 0
       AND no failing required CI AND intent != deviated
```

P2 and P3 are **advisory only** and can never flip the verdict — they are
defined above as "can merge with note" and "optional", so a diff with no P0/P1
findings passes no matter how many nits are surfaced. They still lower the
*reported* `confidence` above (which feeds the merge-risk bands), so the number
in the banner may sit below the threshold on a PASS. That is expected.

Before this split, three P2 nice-to-haves took confidence to 85 and hard-failed
the gate on an otherwise-clean diff, making the verdict turn on ordinary
model-run variance. See ADR 0004.

---

## Merge Risk Assessment

| Condition | Risk |
|---|---|
| Any P0 present, OR > 2 P1 issues | **HIGH** |
| 1–2 P1 issues, OR confidence < 70% | **MEDIUM** |
| Otherwise | **LOW** |

---

## Intent Status Derivation

Derive the intent-alignment status from Angle H results:

| Angle H outcome | Status |
|---|---|
| Ran, no P0/P1 findings (P2 scope creep alone → still Aligned; excess work ≠ missing requirement) | `✅ Aligned` |
| Ran, one or more P1 missing-requirement findings, no P0 | `⚠️ Partial` |
| Ran, found a P0 wrong-solution finding | `❌ Deviated` |
| Short-circuited (hard skip conditions met) | `— skipped` |

### [Intent] Finding Prefix

All findings from Angle H carry an `[Intent]` prefix in the P0/P1/P2 sections so they
are visually distinct from code findings:

```markdown
### P0 — Blockers

- `[Intent]` Issue #42 asks for X but this diff implements Y — wrong solution. <detail>
- `src/api/foo.ts:84` — <code finding>

### P1 — Should Fix

- `[Intent]` AC "must validate tenant scope before returning results" has no implementation in the diff.
- `src/services/bar.ts:201` — <code finding>
```
