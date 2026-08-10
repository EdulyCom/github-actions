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
// Pure: no I/O, no process.env. The caller reads and parses the JSON files.

const SEVERITIES = ["P0", "P1", "P2", "P3"];
const VALID_INTENT = new Set(["aligned", "partial", "deviated", "skipped"]);

// §7a: recall bias where it matters. rubric.md's Verify Pass makes PLAUSIBLE the
// default verdict for the exact class /code-review scores 25-50 ("might be real,
// wasn't able to verify") — concurrency races, nil on a rare path, off-by-one on
// an unexcluded boundary. A flat <80 filter would silently drop that class,
// which is the one the "we had enough of broken apps" stance cares about most.
// P2/P3 keep the stricter bar, where false-positive discipline is noise control.
const CONFIDENCE_FLOOR = { P0: 50, P1: 50, P2: 80, P3: 80 };

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

/** A role file is usable only if it is the shape we froze. */
function malformed(role, f) {
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
  for (const role of roles) {
    if (byRole[role] === undefined) return inconclusive(`missing-role:${role}`);
    const bad = malformed(role, byRole[role]);
    if (bad) return inconclusive(bad);
  }

  // §6 step 2 / §8 row 6 — the partition must cover changed_files exactly, and
  // each role must have reviewed everything it was assigned. This checks the
  // *claim*, not comprehension: it is a tripwire against silent truncation, not
  // proof of reading. Said plainly here so nobody reads more into it.
  const reviewed = new Set();
  for (const role of roles) {
    const f = byRole[role];
    const assigned = Array.isArray(f.assigned_files) ? f.assigned_files : [];
    const seen = new Set(f.files_reviewed);
    for (const p of assigned) {
      if (!seen.has(p)) {
        return inconclusive(`coverage:${role} assigned ${assigned.length}, reviewed ${seen.size}`, {
          expected_files: changed.length,
          reviewed_files: seen.size,
        });
      }
    }
    for (const p of f.files_reviewed) reviewed.add(p);
  }
  const coverage = {
    expected_files: changed.length,
    reviewed_files: reviewed.size,
  };
  for (const p of changed) {
    if (!reviewed.has(p)) {
      return inconclusive(`coverage:${p} was not reviewed by any role`, coverage);
    }
  }

  // §6 step 9 / §8 row 10 — intent is owned by exactly one role and a verdict
  // cannot be reached without it.
  const intent = roles
    .map((r) => byRole[r].intent)
    .find((v) => typeof v === "string" && VALID_INTENT.has(v));
  if (!intent) return inconclusive("no-intent", coverage);

  // §6 step 3 / §8 rows 8-9 — join scores by id and require set equality both
  // ways, so "unscored => dropped => clean" is unreachable.
  const candidates = [];
  for (const role of roles) {
    for (const f of byRole[role].findings) candidates.push(f);
  }
  const s = scores;
  if (!s || typeof s !== "object" || s.complete !== true || !Array.isArray(s.scores)) {
    if (candidates.length > 0) return inconclusive("missing-scores", coverage);
  }
  const scoreList = s && Array.isArray(s.scores) ? s.scores : [];
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
    const key = `${f.file}\u0000${f.line}\u0000${f.reason}`;
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

  const checklist = roles.flatMap((r) =>
    Array.isArray(byRole[r].checklist) ? byRole[r].checklist : [],
  );

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
