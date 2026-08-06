"use strict";

// Deterministic finding arithmetic for the ai-review orchestrator.
//
// The judge does NOT author `counts`. It ranks and may refute; this module
// computes the numbers the gate actually decides on. An earlier design had
// the judge emit counts and cross-checked them, which meant an ordinary
// model arithmetic slip blocked the PR and burned the review. Removing the
// field removes the failure mode.
//
// rubric.md:116-118 calls silent dropping "the dominant cause of misses",
// so dedupe reports every absorption rather than quietly collapsing.
//
// Pure: no I/O, no process.env.

// Two findings in the same file describing the same defect class within this
// many lines are treated as one finding reported twice by different shards.
const LINE_WINDOW = 3;

const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

const rank = (s) => (s in SEVERITY_RANK ? SEVERITY_RANK[s] : SEVERITY_RANK.P3);

/** The worse (lower-ranked) of two severities. */
const worst = (a, b) => (rank(a) <= rank(b) ? a : b);

/**
 * @param {object[]} findings
 * @returns {{findings: object[], absorbed: {kept: string, absorbed: string}[]}}
 */
function dedupe(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const kept = [];
  const absorbed = [];

  for (const candidate of list) {
    if (!candidate || typeof candidate !== "object") continue;

    const match = kept.find(
      (k) =>
        k.file === candidate.file &&
        k.defect_class === candidate.defect_class &&
        Math.abs(Number(k.line) - Number(candidate.line)) <= LINE_WINDOW
    );

    if (match) {
      // Severity is the only field that upgrades on merge: a shard that saw
      // the defect as P0 outranks one that saw it as P2.
      match.severity = worst(match.severity, candidate.severity);
      absorbed.push({ kept: match.id, absorbed: candidate.id });
      continue;
    }

    kept.push({ ...candidate });
  }

  return { findings: kept, absorbed };
}

/**
 * Partition findings by the judge's refutations. A refutation without
 * constructible evidence (a file and a line) is NOT applied — the judge may
 * overrule a worker, but not on assertion alone.
 *
 * @param {object[]} findings
 * @param {object[]} refutations
 * @returns {{retained: object[], refuted: object[]}}
 */
function applyRefutations(findings, refutations) {
  const list = Array.isArray(findings) ? findings : [];
  const refs = Array.isArray(refutations) ? refutations : [];

  const valid = new Set(
    refs
      .filter(
        (r) =>
          r &&
          typeof r.finding_id === "string" &&
          typeof r.evidence_file === "string" &&
          r.evidence_file.length > 0 &&
          Number.isFinite(Number(r.evidence_line))
      )
      .map((r) => r.finding_id)
  );

  const retained = [];
  const refuted = [];
  for (const f of list) {
    (valid.has(f.id) ? refuted : retained).push(f);
  }
  return { retained, refuted };
}

/**
 * @param {object[]} findings
 * @returns {{p0: number, p1: number, p2: number, p3: number}}
 */
function countBySeverity(findings) {
  const counts = { p0: 0, p1: 0, p2: 0, p3: 0 };
  for (const f of Array.isArray(findings) ? findings : []) {
    const key = String(f && f.severity).toLowerCase();
    if (key in counts) counts[key] += 1;
  }
  return counts;
}

module.exports = { dedupe, applyRefutations, countBySeverity, LINE_WINDOW };
