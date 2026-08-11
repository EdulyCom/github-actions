"use strict";

// Deterministic aggregation: role findings + scores -> recompute()'s input.
//
// This replaces a single model turn that self-reported `counts` with nothing
// checking them. Here a finding must be raised, labelled, independently scored,
// and survive a deterministic filter before a counter admits it. Model-reported
// counts are never read (§6 step 8).
//
// The fail-closed principle throughout: absence and cleanliness must never be
// the same byte pattern. A missing role, an unparseable file, a coverage gap or
// an unscored finding all yield `status: "inconclusive"` — which Publish turns
// into an explicit "re-run required" fail, not a pass. Only a complete roster
// with full coverage and every finding scored can produce `status: "ok"`, and
// only then can the result be zero findings (§8 row 7).
//
// DELIBERATE DEVIATION from spec §6's numbered order, documented because the
// schema it implements is frozen: the spec lists the confidence filter (step 4)
// before severity reconciliation (step 5). Applying them in that order lets a
// finding the scorer *upgraded* to P1 be filtered out on the finder's original
// P2 label — the strictest threshold applied to the least severe reading. That
// is fail-open on exactly the findings that block the gate. Reconciliation runs
// first here so the filter always sees the more severe of the two labels. Both
// steps still happen and the emitted schema is unchanged; only their order
// differs, in the fail-closed direction that §7b itself argues for.
//
// Spec §6 step 2 is now implemented in full, over `assigned_files`: pairwise
// disjoint, no stray path, union equal to `changed_files`, and every assigned
// file claimed as reviewed. Disjointness was vacuous at roster size 1. All four
// are asserted here as well as in `lib/roster.js` because that module can only
// assert the roster it *emits*; a role file arrives from a model stage and can
// claim an assignment the roster never made.
//
// Pure: no I/O, no process.env. The caller reads and parses the JSON files.

const SEVERITIES = ["P0", "P1", "P2", "P3"];
const VALID_INTENT = new Set(["aligned", "partial", "deviated", "skipped"]);

/**
 * The role that owns intent (spec §4 "Frame"), by name. Must match the frame
 * role `lib/roster.js` emits — see the intent selection below for why position
 * in the roster is not a safe proxy for it.
 */
const FRAME_ROLE = "intent";

// §7a: recall bias where it matters. rubric.md's Verify Pass makes PLAUSIBLE the
// default verdict for the exact class /code-review scores 25-50 ("might be real,
// wasn't able to verify") — concurrency races, nil on a rare path, off-by-one on
// an unexcluded boundary. A flat <80 filter would silently drop that class,
// which is the one the "we had enough of broken apps" stance cares about most.
// P2/P3 keep the stricter bar, where false-positive discipline is noise control.
// The floors must land ON a rung of that enum. 80 was the spec's starting
// number, but no admissible value lies in [80,100), so it silently meant
// "exactly 100" — and measured runs bore that out: 8 of 8 dropped findings
// across three shadow runs were P2/P3 at 50 or 75, never a marginal case.
// That is threshold granularity, not aggregation, polluting the very evidence
// the shadow step exists to collect. 75 keeps the "might be real, wasn't able
// to verify" band the rubric's recall bias cares about and still drops 50.
// Spec §7a and §11 q2 asked for exactly this to be tuned from observed data.
const CONFIDENCE_FLOOR = { P0: 50, P1: 50, P2: 75, P3: 75 };

// `assigned_files` is git output; `files_reviewed` is model-typed text. A
// leading "./" is the drift seen in practice and is not a coverage failure.
const normPath = (p) => String(p ?? "").trim().replace(/^\.\//, "");

const rank = (sev) => {
  const i = SEVERITIES.indexOf(sev);
  return i === -1 ? SEVERITIES.length : i;
};

/** More severe of two labels; P0 beats P1 beats P2 beats P3. */
const moreSevere = (a, b) => (rank(a) <= rank(b) ? a : b);

function inconclusive(reason, coverage) {
  return {
    status: "inconclusive",
    reason,
    review: null,
    kept: [],
    dropped: [],
    coverage: coverage || { expected_files: 0, reviewed_files: 0 },
    summary_markdown: "",
    warnings: [],
  };
}

/**
 * A role file is usable only if it is the shape we froze.
 *
 * `ids` is supplied by the caller and shared across every role on purpose —
 * see the duplicate check below.
 */
function malformed(role, f, ids) {
  if (f === null || typeof f !== "object") return `malformed:${role}`;
  if (f.schema !== 1) return `malformed:${role}`;
  if (f.complete !== true) return `malformed:${role}`;
  if (!Array.isArray(f.findings)) return `malformed:${role}`;
  if (!Array.isArray(f.files_reviewed)) return `malformed:${role}`;

  // Validate each finding, not just the envelope. A finding whose severity is
  // not one of P0-P3 has no entry in CONFIDENCE_FLOOR, so the filter below
  // would compare against `undefined`, take the false branch, and route it to
  // dropped[] — silently discarding a finding that might be a P0 because its
  // label was garbled. That is precisely the "absence must never read as
  // cleanliness" failure this module exists to prevent, so it is inconclusive.
  for (const item of f.findings) {
    if (item === null || typeof item !== "object") return `malformed:${role}`;
    if (typeof item.id !== "string" || item.id === "") return `malformed:${role}`;
    if (!SEVERITIES.includes(item.severity)) return `malformed:${role}`;
    // Ids are model-invented and the schema does not require uniqueness. A
    // collision would collapse the score join below (Map, last wins) while the
    // set-equality assertions stayed green, because Sets are duplicate-blind —
    // reproduced as a P0@100 colliding with a P3@25 yielding verdict pass.
    //
    // The set spans ALL roles, not one. `derive-findings.js` does namespace ids
    // by role, but a role file is untrusted input to this module and it cannot
    // assume the deriver produced it — this is the last line of defence, not a
    // duplicate of that one. A per-role set would validate each file happily and
    // let a collision through to the join, which is the identical fail-open
    // reached from the direction fan-out opens up.
    if (ids.has(item.id)) return `malformed:${role}:duplicate finding id ${item.id}`;
    ids.add(item.id);
  }
  return null;
}

function aggregate({ manifest, roster, findings, scores }) {
  const m = manifest || {};
  const changed = Array.isArray(m.changed_files) ? m.changed_files : [];
  const roles = Array.isArray(roster) ? roster : [];
  const byRole = findings && typeof findings === "object" ? findings : {};

  // §8 row 1 — an empty diff is anomalous on a real PR and is exactly the class
  // the previously reverted attempt turned into a confident PASS.
  if (m.empty_diff === true || changed.length === 0) {
    return inconclusive("empty-diff", { expected_files: 0, reviewed_files: 0 });
  }

  // §8 row 3 — nothing was produced at all.
  const present = roles.filter((r) => byRole[r] !== undefined);
  if (present.length === 0) {
    return inconclusive("no-findings-dir", {
      expected_files: changed.length,
      reviewed_files: 0,
    });
  }

  // §6 step 1 / §8 rows 4-5 — every rostered role produced a parseable,
  // complete file. A dead role is named rather than averaged away.
  // Coverage is passed explicitly on every exit — `inconclusive()` defaults to
  // `expected_files: 0`, which is an empty diff's tally, and a dead role on a
  // 12-file PR logging the same numbers as an empty diff is exactly the
  // absence-reads-as-cleanliness confusion this module exists to prevent.
  const nothingVerified = { expected_files: changed.length, reviewed_files: 0 };
  const findingIds = new Set();
  for (const role of roles) {
    if (byRole[role] === undefined) return inconclusive(`missing-role:${role}`, nothingVerified);
    const bad = malformed(role, byRole[role], findingIds);
    if (bad) return inconclusive(bad, nothingVerified);
  }

  // §6 step 2 / §8 row 6, in two passes over two different properties.
  //
  // PASS 1 — the ASSIGNMENT is a partition of changed_files: pairwise disjoint,
  // no stray path, nothing left unowned. Only `assigned_files` is a partition;
  // `files_reviewed` may overlap freely and may range outside the diff, since
  // reading a neighbouring file for context is what a reviewer should do. That
  // is exactly why coverage cannot be argued from `files_reviewed` alone — a
  // file assigned to nobody but incidentally opened by somebody would satisfy a
  // reviewed-union while no role ever owned it.
  //
  // `lib/roster.js` asserts the same three properties on the roster it emits.
  // Repeating them here is not belt-and-braces: a role file arrives from a model
  // stage and can claim an assignment the roster never made, so this module has
  // to validate review output independently of the roster that produced it.
  //
  // The coverage payload reports `reviewed_files: 0` on these failures because
  // nothing has been verified as reviewed yet — a partial tally would read as a
  // coverage shortfall, which is precisely what a partition error is not.
  const partitionCoverage = nothingVerified;
  const changedSet = new Set(changed.map(normPath));
  const assignedBy = new Map();
  for (const role of roles) {
    const assigned = (Array.isArray(byRole[role].assigned_files) ? byRole[role].assigned_files : [])
      .map(normPath);
    for (const p of assigned) {
      const owner = assignedBy.get(p);
      if (owner !== undefined && owner !== role) {
        // Not a coverage gap: the union still matches and every other assertion
        // stays green. It means the roster was built wrong — the file is read
        // twice, and one defect can surface under two ids that the
        // deterministic dedupe cannot merge when the reported line differs.
        return inconclusive(`partition:${p} assigned to both ${owner} and ${role}`, partitionCoverage);
      }
      if (!changedSet.has(p)) {
        // The role was built against a different diff than the one being gated.
        return inconclusive(
          `partition:${p} assigned to ${role} but is not in changed_files`,
          partitionCoverage,
        );
      }
      assignedBy.set(p, role);
    }
  }
  for (const p of changedSet) {
    if (!assignedBy.has(p)) {
      return inconclusive(`partition:${p} was assigned to no role`, partitionCoverage);
    }
  }

  // PASS 2 — each role reviewed everything it was assigned. This checks the
  // *claim*, not comprehension: a tripwire against silent truncation, not proof
  // of reading. Said plainly here so nobody reads more into it. Combined with
  // pass 1, every changed file is now owned by a role that says it read it.
  const reviewed = new Set();
  for (const role of roles) {
    const f = byRole[role];
    const assigned = (Array.isArray(f.assigned_files) ? f.assigned_files : []).map(normPath);
    const seen = new Set(f.files_reviewed.map(normPath));
    for (const p of assigned) {
      if (!seen.has(p)) {
        // Name the path. This step's only product is a diagnosable log line,
        // and "assigned 11, reviewed 8" cannot be acted on.
        //
        // Intersected with the diff, like the success path twelve lines below —
        // `seen` is the failing role's raw files_reviewed, which is explicitly
        // allowed to range outside changed_files. A role assigned 5 files that
        // reviewed 4 plus 10 out-of-diff neighbours would otherwise report
        // "expected 5, reviewed 14" on an exit whose entire meaning is that a
        // file was NOT reviewed.
        return inconclusive(
          `coverage:${role} did not review ${p} (assigned ${assigned.length}, reviewed ${seen.size})`,
          {
            expected_files: changed.length,
            reviewed_files: [...seen].filter((r) => changedSet.has(r)).length,
          },
        );
      }
    }
    for (const p of seen) reviewed.add(p);
  }
  const coverage = {
    expected_files: changed.length,
    // Intersected with the diff, not the raw union. `files_reviewed` is allowed
    // to range outside `changed_files`, so a reviewer assigned 3 files that opens
    // 5 neighbours would otherwise report "expected 3, reviewed 8" — a ratio that
    // reads as nonsense and is the per-role tally fan-out will scrape.
    reviewed_files: [...reviewed].filter((p) => changedSet.has(p)).length,
  };

  // §6 step 9 / §8 row 10 — intent is owned by exactly one role and a verdict
  // cannot be reached without it.
  //
  // "Exactly one role" is enforced two ways, because selecting on array position
  // satisfies neither. `derive-findings.js` stamps `intent` onto every role file
  // unconditionally, so a reviewer that saw one slice of the diff — and
  // structurally cannot judge the PR's goal — would shadow the role whose entire
  // mandate that is. If it says `aligned` where the frame role says `deviated`,
  // the gate reads `aligned` and passes: fail-open, in the direction step 9
  // exists to close.
  //
  //   1. If the frame role is ROSTERED, its value is the only one consulted. An
  //      unusable value from it is `no-intent`, never a licence to poll the
  //      coverage roles — a garbled frame answer is exactly when the fallback is
  //      most likely to substitute a slice-local opinion for a whole-PR one.
  //   2. Only when no frame role is rostered does first-valid-wins apply. That
  //      is the serial roster, where one `review-serial` role owns intent itself.
  //
  // Membership in `roles` is what makes a file eligible, not presence in
  // `byRole`: an entry the roster never declared was never seen by malformed(),
  // so preferring one would route an unvalidated value into the verdict. The
  // `byRole[FRAME_ROLE] !== undefined` half is now redundant with that check —
  // the roster loop above already returns `missing-role:` for any rostered role
  // absent from `byRole` — but is kept so this line does not depend on running
  // after that loop to stay correct.
  const validIntent = (v) => typeof v === "string" && VALID_INTENT.has(v);
  const hasFrame = roles.includes(FRAME_ROLE) && byRole[FRAME_ROLE] !== undefined;
  const intent = hasFrame
    ? (validIntent(byRole[FRAME_ROLE].intent) ? byRole[FRAME_ROLE].intent : null)
    : roles.map((r) => byRole[r].intent).find(validIntent);
  if (!intent) {
    return inconclusive(hasFrame ? `no-intent:${FRAME_ROLE} value unusable` : "no-intent", coverage);
  }

  // §6 step 3 / §8 rows 8-9 — join scores by id and require set equality both
  // ways, so "unscored => dropped => clean" is unreachable.
  const candidates = [];
  for (const role of roles) {
    for (const f of byRole[role].findings) candidates.push(f);
  }
  // Unconditional. This used to fire only when `candidates.length > 0`, so a
  // dead scorer plus a run where every coverage reviewer legitimately found
  // nothing produced a CLEAN verdict: the guard stayed quiet, `scoreList` fell
  // back to `[]`, and both set-equality loops iterated nothing. §8 treats a dead
  // role as inconclusive regardless of what the other roles found, and the
  // roster loop above already names every other one — the scorer was the single
  // exemption, on the one artifact that arrives outside that loop.
  const s = scores;
  if (!s || typeof s !== "object" || s.complete !== true || !Array.isArray(s.scores)) {
    return inconclusive("missing-scores", coverage);
  }
  // `s.scores` is guaranteed an array by the guard above — no fallback needed,
  // and no room for one to quietly resurrect the dead-scorer-reads-clean bug
  // this guard exists to close.
  const scoreList = s.scores;

  // Validate each score entry, symmetric to the finding-level checks above.
  // Without this, Number(undefined) is NaN and Number(null) is 0 — both take
  // the drop branch below — so a P0 the scorer CONFIRMED as P0 would land in
  // dropped[], counts.p0 would be 0, and recompute() would return pass. A
  // missing number must be inconclusive, never a silent acquittal.
  const scoreIds = new Set();
  for (const x of scoreList) {
    if (x === null || typeof x !== "object") return inconclusive("malformed:scorer", coverage);
    if (typeof x.id !== "string" || x.id === "") return inconclusive("malformed:scorer", coverage);
    if (scoreIds.has(x.id)) {
      return inconclusive(`malformed:scorer:duplicate score id ${x.id}`, coverage);
    }
    scoreIds.add(x.id);
    if (typeof x.confidence !== "number" || !Number.isFinite(x.confidence)) {
      return inconclusive(`malformed:scorer:${x.id} has no usable confidence`, coverage);
    }
  }
  const scoreById = new Map(scoreList.map((x) => [x.id, x]));
  const candIds = new Set(candidates.map((c) => c.id));
  for (const c of candidates) {
    if (!scoreById.has(c.id)) return inconclusive(`score-gap:${c.id} unscored`, coverage);
  }
  for (const x of scoreList) {
    if (!candIds.has(x.id)) return inconclusive(`score-gap:${x.id} scores an unknown finding`, coverage);
  }

  // §6 steps 5 then 4 — reconcile severity, then filter on the reconciled label
  // (see the deviation note in the header).
  const kept = [];
  const dropped = [];
  for (const c of candidates) {
    const sc = scoreById.get(c.id);
    // An unusable scorer label falls back to the finder's rather than ranking
    // as "worse than P3" and silently downgrading a real blocker.
    const confirmed = SEVERITIES.includes(sc.severity_confirmed)
      ? sc.severity_confirmed
      : c.severity;
    const severity = moreSevere(c.severity, confirmed);
    const confidence = Number(sc.confidence);
    const floor = CONFIDENCE_FLOOR[severity];
    const entry = { ...c, severity, confidence };
    if (floor === undefined || !Number.isFinite(confidence) || confidence < floor) {
      dropped.push({ ...entry, dropped_because: `confidence ${confidence} < ${floor} for ${severity}` });
    } else {
      kept.push(entry);
    }
  }

  // §6 step 6 — deterministic dedupe only. Over-counting is tolerated because it
  // fails closed (more findings -> lower gate confidence); a model-mediated
  // "these are duplicates" merge is a channel through which a real P0 could be
  // argued away.
  const deduped = [];
  const seenKeys = new Set();
  for (const f of kept) {
    // normPath, like every other path comparison here. `finding.file` is
    // model-typed text and `malformed()` never validates it, so two roles
    // spelling one path "./src/a.ts" and "src/a.ts" counted the same defect
    // twice. Over-counting fails closed, so this was a weaker-than-intended
    // §6.6 rather than a fail-open — and the fix costs nothing.
    const key = `${normPath(f.file)}\u0000${f.line}\u0000${f.reason}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    deduped.push(f);
  }

  // §6 step 7 — deterministic injections. Model-independent by construction, so
  // an instruction embedded in the very file being flagged cannot suppress its
  // own flag.
  let injected = 0;
  const inject = (summary) => {
    injected += 1;
    deduped.push({
      id: `deterministic/${String(injected).padStart(4, "0")}`,
      file: null,
      line: null,
      severity: "P2",
      summary,
      failure_scenario: "n/a — derived from the diff manifest, not model judgment",
      reason: "process",
      evidence: "manifest.json",
      confidence: 100,
    });
  };
  if (m.title_ok === false) {
    inject("PR title is not a valid Conventional Commits subject.");
  }
  if (m.modifies_reviewer_guidance === true) {
    inject("This PR modifies the guidance files reviewers themselves read (CLAUDE.md / .claude/).");
  }

  // §6 step 8 — count from the final set. Never from the model.
  const counts = { p0: 0, p1: 0, p2: 0, p3: 0 };
  for (const f of deduped) {
    const k = f.severity.toLowerCase();
    if (k in counts) counts[k] += 1;
  }

  // Single-owner, for the same reason as intent and with a sharper downstream
  // consequence. `derive-findings.js` stamps `checklist` onto every role file,
  // so concatenating gives K copies of each item, possibly with conflicting
  // statuses. `publish.js` counts verified items per normalized text precisely
  // so one verified item cannot tick several boxes that normalize identically —
  // inflating that count to K reopens the collision the counter exists to
  // prevent. The frame role owns the checklist because it owns the intent
  // contract the checklist is derived from.
  const checklist = hasFrame
    ? (Array.isArray(byRole[FRAME_ROLE].checklist) ? byRole[FRAME_ROLE].checklist : [])
    : roles.flatMap((r) => (Array.isArray(byRole[r].checklist) ? byRole[r].checklist : []));

  return {
    status: "ok",
    reason: null,
    review: {
      counts,
      intent,
      // Constants since 939a4e2 removed test execution from the review stage.
      test_execution: "skipped",
      tests_failing: false,
      verification_evidence: [],
      // §6 step 10 — path classification from the manifest, not model judgment.
      no_tests_for_changed_logic: m.no_tests_for_changed_logic === true,
      coverage_below_threshold_on_critical_paths: false,
      checklist,
    },
    kept: deduped,
    dropped,
    coverage,
    summary_markdown: "",
    warnings: [],
  };
}

module.exports = { aggregate, moreSevere, CONFIDENCE_FLOOR };
