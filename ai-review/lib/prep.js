"use strict";

// Deterministic prep for the ai-review pipeline.
//
// Everything here is work the review session currently does for itself, in
// model turns, on every run. The review prompt tells the model to discover the
// default branch, diff against the merge base, and judge the PR title — all of
// which are cheap, exact, and testable off the model's critical path.
//
// Two reasons that matters beyond turn count:
//
//   1. Wall-clock is linear in turns (measured: duration ~= turns * 24s across
//      682 jobs), so every turn spent re-deriving a fact a shell command
//      already knows is pure latency.
//   2. A model deriving the diff base by hand can derive it from a false
//      premise and review the wrong range. A staged, asserted manifest makes
//      that failure impossible rather than unlikely.
//
// `no_tests_for_changed_logic` (worth -15 in recompute.js) and the
// Conventional-Commits title check move here from model judgment to path
// classification, per the parallel-review spec §3.
//
// Pure: no I/O, no process.env, no git. The caller runs the git commands and
// passes their stdout in. The schema is frozen by spec §6 so the fan-out work
// can consume it unchanged.

/** Conventional Commits types accepted in a PR title. */
const COMMIT_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];

const TITLE_RE = new RegExp(`^(?:${COMMIT_TYPES.join("|")})(?:\\([^)]+\\))?!?: \\S`);

/** Extensions that carry executable logic (as opposed to prose or fixtures). */
const CODE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rb", "java", "kt",
  "kts", "rs", "php", "cs", "swift", "scala", "sh", "bash", "sql", "vue",
  "svelte",
]);

/** Markdown a reviewer is told to read as conventions — see spec §10. */
const GUIDANCE_RE = /(^|\/)CLAUDE\.md$|(^|\/)\.claude\//;

/**
 * Directory names that mark a test tree. Exported because `lib/roster.js` needs
 * the same alternation and the two copies had already drifted — it is the one
 * piece of test-path knowledge both modules genuinely share. The rest cannot be
 * shared: this module needs a yes/no for the `no_tests_for_changed_logic`
 * penalty, while the roster needs to *strip* the marker to find a test's partner
 * source file, and one regex serving both would be too loose to classify and too
 * imprecise to strip.
 */
const TEST_DIR_SEGMENTS = "tests?|spec|__tests__|__mocks__";

const TEST_RE = new RegExp(
  `(^|/)(${TEST_DIR_SEGMENTS})/|(\\.|_)(test|spec)\\.[A-Za-z0-9]+$`,
);

/**
 * Resolve git's two rename spellings to the post-rename path.
 *   "src/{old => new}/a.ts" -> "src/new/a.ts"
 *   "lib/old.ts => lib/new.ts" -> "lib/new.ts"
 */
function resolveRename(path) {
  const braced = path.replace(/\{[^{}]*?=>\s*([^{}]*?)\}/g, (_m, to) => to.trim());
  if (braced !== path) return braced.replace(/\/{2,}/g, "/");
  const arrow = braced.indexOf(" => ");
  return arrow === -1 ? braced : braced.slice(arrow + 4).trim();
}

/**
 * Parse `git diff --numstat <base>...HEAD`.
 *
 * Binary files are reported by git as "-\t-\tpath". They count as changed
 * files but contribute zero churn — matching the awk in the routing step this
 * replaces, so routing behaviour does not shift under the refactor.
 *
 * @returns {{files: Array<{path,added,removed,binary}>, fileCount: number, churn: number}}
 */
function parseNumstat(numstatText) {
  const files = [];
  let churn = 0;

  for (const raw of String(numstatText ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (line === "") continue;

    const parts = line.split("\t");
    if (parts.length < 3) continue;

    const [addedRaw, removedRaw] = parts;
    const path = resolveRename(parts.slice(2).join("\t"));
    if (path === "") continue;

    const binary = addedRaw === "-" || removedRaw === "-";
    const added = binary ? 0 : Number.parseInt(addedRaw, 10) || 0;
    const removed = binary ? 0 : Number.parseInt(removedRaw, 10) || 0;

    churn += added + removed;
    files.push({ path, added, removed, binary });
  }

  return { files, fileCount: files.length, churn };
}

/**
 * Extract candidate changed symbols from hunk headers.
 *
 * `git diff` puts the enclosing declaration after the second `@@`. This is
 * regex-grade on purpose: the cross-file tracer needs a list of names to chase
 * with Grep, not a compiler-accurate AST. Over-collection is harmless (a name
 * with no consumers is one wasted search); a miss is not, so the fallback
 * pattern is deliberately loose.
 *
 * @returns {Array<{kind: string, name: string, file: string}>}
 */
function extractSymbols(diffText) {
  const out = [];
  const seen = new Set();
  let file = null;

  const patterns = [
    [/\bclass\s+([A-Za-z_$][\w$]*)/, "class"],
    [/\b(?:function|func|def|fn)\s+([A-Za-z_$][\w$]*)/, "function"],
    [/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, "binding"],
    [/([A-Za-z_$][\w$]*)\s*\(/, "function"],
  ];

  for (const raw of String(diffText ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");

    const header = /^diff --git a\/(?:.+) b\/(.+)$/.exec(line);
    if (header) {
      file = header[1].trim();
      continue;
    }

    const hunk = /^@@[^@]*@@\s*(.*)$/.exec(line);
    if (!hunk) continue;

    const context = hunk[1].trim();
    if (context === "" || file === null) continue;

    for (const [re, kind] of patterns) {
      const m = re.exec(context);
      if (!m) continue;
      const key = `${file}\u0000${m[1]}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ kind, name: m[1], file });
      }
      break;
    }
  }

  return out;
}

/** True when the PR title parses as a Conventional Commits subject. */
function isConventionalTitle(title) {
  return typeof title === "string" && TITLE_RE.test(title.trim());
}

/**
 * Classify changed paths.
 *
 * `noTestsForChangedLogic` mirrors recompute.js's -15 penalty. Deriving it
 * from paths rather than model judgment means it cannot be argued away in a
 * review body.
 */
function classifyPaths(paths) {
  const list = Array.isArray(paths) ? paths : [];
  let hasTestChange = false;
  let hasLogicChange = false;
  let modifiesReviewerGuidance = false;

  for (const p of list) {
    const path = String(p ?? "");
    if (path === "") continue;

    if (GUIDANCE_RE.test(path)) modifiesReviewerGuidance = true;

    if (TEST_RE.test(path)) {
      hasTestChange = true;
      continue;
    }

    const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "";
    if (CODE_EXT.has(ext)) hasLogicChange = true;
  }

  return {
    hasTestChange,
    hasLogicChange,
    modifiesReviewerGuidance,
    noTestsForChangedLogic: hasLogicChange && !hasTestChange,
  };
}

/**
 * Assemble the manifest the review stage is told to trust.
 *
 * @param {object} args
 * @param {string} args.baseSha   PR merge-base (telemetry; not always the diff base)
 * @param {string} args.headSha   PR head commit
 * @param {string} args.numstat   stdout of `git diff --numstat <reviewBase> HEAD`
 *   where reviewBase is delta_base_sha in delta mode, else the merge-base
 * @param {string} args.diff      stdout of `git diff -U0 <reviewBase> HEAD` (headers only)
 * @param {object} args.sizes     path -> full-file byte size at HEAD (`git cat-file -s`)
 * @param {string} args.title     PR title
 * @param {'full'|'delta'} [args.reviewMode='full']
 * @param {string|null} [args.deltaBaseSha=null]  prior published head when delta
 * @param {string|null} [args.priorHeadSha=null]
 */
function buildManifest({
  baseSha,
  headSha,
  numstat,
  diff,
  sizes,
  title,
  reviewMode,
  deltaBaseSha,
  priorHeadSha,
}) {
  const { files, fileCount, churn } = parseNumstat(numstat);
  const changed = files.map((f) => f.path);
  const sizeMap = sizes && typeof sizes === "object" ? sizes : {};
  const classes = classifyPaths(changed);
  const mode = reviewMode === "delta" ? "delta" : "full";

  const totalBytes = changed.reduce((sum, p) => {
    const n = Number(sizeMap[p]);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);

  return {
    schema: 1,
    base_sha: baseSha ?? null,
    head_sha: headSha ?? null,
    review_mode: mode,
    delta_base_sha: mode === "delta" ? deltaBaseSha ?? null : null,
    prior_head_sha: priorHeadSha ?? null,
    changed_files: changed,
    file_count: fileCount,
    churn,
    total_fullfile_bytes: totalBytes,
    empty_diff: fileCount === 0,
    title_ok: isConventionalTitle(title),
    has_test_change: classes.hasTestChange,
    has_logic_change: classes.hasLogicChange,
    no_tests_for_changed_logic: classes.noTestsForChangedLogic,
    modifies_reviewer_guidance: classes.modifiesReviewerGuidance,
    symbol_manifest: extractSymbols(diff),
  };
}

module.exports = {
  TEST_DIR_SEGMENTS,
  parseNumstat,
  extractSymbols,
  isConventionalTitle,
  classifyPaths,
  buildManifest,
};
