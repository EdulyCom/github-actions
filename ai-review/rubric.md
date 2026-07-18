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

Load `/tmp/main-issue.json` and the PR body from `/tmp/pr-meta.json`. Establish the
**stated goal**: what was this change supposed to do?

Extract acceptance criteria in this priority order:
1. Explicit checklist items (`- [ ]` / `- [x]`) in issue or PR body
2. Numbered requirements or "must/should" statements
3. Inferred intent from title + description narrative

Compare against the diff:

| Signal | Finding | Severity |
|--------|---------|----------|
| Diff implements something that doesn't address the stated goal, or moves in a different direction | **Wrong solution** — quote the goal and the divergence | **P0** |
| A clearly stated AC or requirement has no corresponding implementation | **Missing requirement** — name the AC | **P1** |
| Diff implements significantly more than what was asked | **Scope creep** — flag what's extra | **P2** |
| PR body and linked issue together are too thin to establish intent (present but vague) | Note `"intent alignment: insufficient spec context"` | No finding |

**Skip conditions — two hard triggers only (no finding):**
- `main-issue.json` is `{}` AND PR body and title together are under 50 words → `"intent alignment skipped — insufficient context"`
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
make a call unsafe?

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
- [ ] If PR description has a checklist, count completed vs. incomplete; report ratio
  as P2 reminder for unchecked items (do NOT fail the review on checklist status —
  checklists often track post-merge activities).

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

**Test execution:** auto-detect the command (e.g. Nx affected, turbo, plain `npm test`,
pytest, etc.). If `${user_config.TEST_COMMAND}` is set, use that. If nothing detected and
no override, report as P3 ("tests skipped — no command detected or configured") and
continue.

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
- No tests at all for changed logic: −15.

| Confidence | Label |
|---|---|
| ≥ 85% | High — ready to merge (with threshold check) |
| 70–84% | Medium — minor issues documented |
| 50–69% | Low — P1s requiring fix |
| < 50% | Very Low — P0s found or major gaps |

**Pass threshold:** `confidence ≥ ${user_config.AI_REVIEW_CONFIDENCE_THRESHOLD}` (default
**90**) AND `P0_count == 0` AND `P1_count == 0` → PASS; else FAIL.

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
