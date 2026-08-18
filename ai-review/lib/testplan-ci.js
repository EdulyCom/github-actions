"use strict";

// Test Plan ↔ CI helpers (spec §7 / frozen §10).
//
// Pure extract/summarize for Prep artifacts:
//   .ai-review/test-plan-items.json
//   .ai-review/ci-checks.json
// Mapping quality is model-assisted in the review prompt; optional
// findObviousUncoveredItems is a coarse keyword heuristic for tests.

const fs = require("node:fs");
const path = require("node:path");

const DIR = ".ai-review";

const CHECKBOX_RE = /^\s*[-*]\s*\[(?: |x|X)\]\s+(.+?)\s*$/;
const PLAIN_BULLET_RE = /^\s*[-*]\s+(?!\[)(.+?)\s*$/;
const NUMBERED_RE = /^\s*\d+[.)]\s+(.+?)\s*$/;
const HEADING_TEST_PLAN_RE = /^(#{1,6})\s*test\s*plan\b/i;
const BARE_TEST_PLAN_RE = /^\s*\*{0,2}test\s*plan\*{0,2}\s*:?\s*$/i;

/**
 * @param {string|null|undefined} prBody
 * @returns {string[]}
 */
function extractTestPlanItems(prBody) {
  if (typeof prBody !== "string" || !prBody.trim()) return [];

  const section = extractTestPlanSection(prBody);
  if (section != null) {
    // Union checkboxes and plain/numbered bullets (neither extractor alone).
    const fromSection = unique([
      ...extractCheckboxes(section),
      ...extractPlainListItems(section),
    ]);
    if (fromSection.length) return fromSection;
    // Empty Test Plan section → still honor body checkboxes elsewhere
    // (spec: section and/or checklist items).
    return unique(extractCheckboxes(prBody));
  }

  return unique(extractCheckboxes(prBody));
}

/**
 * @param {string} body
 * @returns {string|null} section text after the heading, or null if absent
 */
function extractTestPlanSection(body) {
  const lines = body.split(/\r?\n/);
  let start = -1;
  let startLevel = 2;

  for (let i = 0; i < lines.length; i++) {
    const hm = lines[i].match(HEADING_TEST_PLAN_RE);
    if (hm) {
      start = i + 1;
      startLevel = hm[1].length;
      break;
    }
    if (BARE_TEST_PLAN_RE.test(lines[i])) {
      start = i + 1;
      startLevel = 2;
      break;
    }
  }
  if (start < 0) return null;

  const out = [];
  for (let i = start; i < lines.length; i++) {
    const hm = lines[i].match(/^(#{1,6})\s+\S/);
    if (hm && hm[1].length <= startLevel) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function extractCheckboxes(text) {
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(CHECKBOX_RE);
    if (m) items.push(m[1].trim());
  }
  return items;
}

/**
 * Non-checkbox bullets / numbered items (used inside a Test Plan section).
 * @param {string} text
 * @returns {string[]}
 */
function extractPlainListItems(text) {
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    const b = line.match(PLAIN_BULLET_RE);
    if (b) {
      items.push(b[1].trim());
      continue;
    }
    const n = line.match(NUMBERED_RE);
    if (n) items.push(n[1].trim());
  }
  return items;
}

/**
 * Prefer a completed check-run row when the Checks API returns the same
 * name twice (in_progress then completed is common on first PR events).
 * @param {string} status
 * @returns {number}
 */
function checkRowRank(status) {
  if (status === "completed") return 2;
  if (status === "in_progress") return 1;
  return 0;
}

/**
 * @param {unknown} checkRuns GitHub Checks API `.check_runs` array
 * @returns {{ name: string, conclusion: string|null, status: string }[]}
 */
function summarizeCiChecks(checkRuns) {
  if (!Array.isArray(checkRuns)) return [];
  const byName = new Map();
  for (const r of checkRuns) {
    if (!r || typeof r !== "object") continue;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!name) continue;
    const status = typeof r.status === "string" ? r.status : "";
    const conclusion =
      r.conclusion == null || r.conclusion === ""
        ? null
        : String(r.conclusion);
    const next = { name, conclusion, status };
    const prev = byName.get(name);
    if (!prev || checkRowRank(status) >= checkRowRank(prev.status)) {
      byName.set(name, next);
    }
  }
  return [...byName.values()];
}

/**
 * Coarse keyword overlap: item tokens (≥3 chars) vs check names.
 * True misses for tests / prompt hints — not authoritative coverage.
 *
 * @param {string[]} items
 * @param {{ name: string }[]} checks
 * @returns {string[]}
 */
function findObviousUncoveredItems(items, checks) {
  if (!Array.isArray(items) || !items.length) return [];
  const checkTokenSets = (Array.isArray(checks) ? checks : []).map((c) =>
    new Set(tokenize(c && c.name))
  );
  return items.filter((item) => {
    const tokens = tokenize(item);
    if (!tokens.length) return true;
    for (const cts of checkTokenSets) {
      if (tokens.some((t) => cts.has(t))) return false;
    }
    return true;
  });
}

/**
 * @param {string} s
 * @returns {string[]}
 */
function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

/**
 * @param {string[]} arr
 * @returns {string[]}
 */
function unique(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (!x || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

/**
 * @param {{
 *   prBody?: string,
 *   checkRuns?: unknown,
 *   dir?: string,
 *   io?: {
 *     writeFile?: typeof fs.writeFileSync,
 *     mkdir?: typeof fs.mkdirSync,
 *     log?: (s: string) => void,
 *   },
 * }} args
 */
function writeTestPlanCiArtifacts({
  prBody = "",
  checkRuns = [],
  dir = DIR,
  io,
} = {}) {
  const writeFile = (io && io.writeFile) || fs.writeFileSync;
  const mkdir =
    (io && io.mkdir) || ((p) => fs.mkdirSync(p, { recursive: true }));
  const log = (io && io.log) || ((s) => process.stderr.write(s));

  const items = extractTestPlanItems(prBody);
  const checks = summarizeCiChecks(checkRuns);

  mkdir(dir);
  writeFile(
    path.join(dir, "test-plan-items.json"),
    `${JSON.stringify({ schema: 1, items }, null, 2)}\n`,
  );
  writeFile(
    path.join(dir, "ci-checks.json"),
    `${JSON.stringify({ schema: 1, checks }, null, 2)}\n`,
  );

  log(
    `testplan-ci: ${items.length} test-plan item(s), ${checks.length} check(s)\n`,
  );

  return { items, checks };
}

function main() {
  const dir = process.env.AI_REVIEW_DIR || DIR;
  const bodyPath =
    process.env.PR_BODY_PATH || path.join(dir, "pr-body.md");
  const checksPath =
    process.env.CHECK_RUNS_PATH || path.join(dir, "check-runs.raw.json");

  let prBody = "";
  try {
    prBody = fs.readFileSync(bodyPath, "utf8");
  } catch {
    prBody = "";
  }

  let checkRuns = [];
  try {
    checkRuns = JSON.parse(fs.readFileSync(checksPath, "utf8"));
  } catch {
    checkRuns = [];
  }
  if (!Array.isArray(checkRuns)) checkRuns = [];

  writeTestPlanCiArtifacts({ prBody, checkRuns, dir });
}

module.exports = {
  extractTestPlanItems,
  extractTestPlanSection,
  extractCheckboxes,
  summarizeCiChecks,
  findObviousUncoveredItems,
  writeTestPlanCiArtifacts,
  main,
};

if (require.main === module) main();
