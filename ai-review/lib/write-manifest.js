"use strict";

// Thin I/O wrapper around lib/prep.js and lib/roster.js — the only entry point
// that touches the filesystem, so the parsing itself stays pure and unit-tested.
//
// Reads (all produced by the prep step's git commands, all relative to the
// checked-out PR head):
//   .ai-review/numstat.txt       git diff --numstat <base> HEAD
//   .ai-review/diff-headers.txt  `diff --git` and `@@` lines only
//   .ai-review/pr-title.txt      PR title, fetched with gh
//
// Writes .ai-review/manifest.json and .ai-review/assignments.json, and prints a
// one-line summary for the job log.
//
// Full-file sizes come from `fs.statSync` rather than `git cat-file -s`: the
// working tree is already checked out at HEAD, so a stat is both cheaper and
// exactly the byte count a reviewer reading the file will face. A deleted path
// has no entry and contributes 0.
//
// The roster is load-bearing for Slice 3 OSH routing (K → collapse vs fanout).
// A failed build/write must fail the prep step — never silently skip.

const fs = require("node:fs");
const path = require("node:path");

const { buildManifest, parseNumstat } = require("./prep.js");

const DIR = ".ai-review";

/**
 * Write JSON to `p` atomically: temp file in the same directory, then rename.
 *
 * A bare `fs.writeFileSync(p, ...)` can leave a truncated file at `p` if it
 * fails partway through (ENOSPC, a killed process). On a write failure
 * `writeRoster` logs then rethrows (fail-closed); without an atomic rename a
 * truncated `assignments.json` could still sit on disk after prep already
 * failed. `rename(2)` on the same filesystem is atomic: `p` either has the
 * old content (nothing existed) or the complete new content, never a partial
 * write. `writeFile`/`renameSync` are injectable for the same reason the rest
 * of this module's I/O is.
 */
function atomicWriteJson(p, obj, io) {
  const writeFile = (io && io.writeFile) || fs.writeFileSync;
  const renameFile = (io && io.renameFile) || fs.renameSync;
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`);
    renameFile(tmp, p);
  } finally {
    // Best-effort cleanup if the write threw before rename — never masks the
    // original error, never throws itself if the temp file never existed.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing more to do */
    }
  }
}

/**
 * Files above this are not read for import edges. A minified bundle or a
 * checked-in lockfile yields no useful adjacency and would dominate this step's
 * runtime; it is still stat'd, still assigned, and still read in full by its
 * reviewer. Only the clustering *hint* is skipped.
 */
const IMPORT_SCAN_MAX_BYTES = 512 * 1024;

/**
 * Extensions worth scanning for import edges.
 *
 * `extractImports` only understands JS/TS spellings, so anything else is read
 * for nothing. More to the point, the catch below used to be documented as the
 * binary guard — but the real reader is `readFileSync(p, "utf8")`, which
 * substitutes U+FFFD for invalid sequences instead of throwing, so a changed
 * 200 KB PNG sailed under the size ceiling and got decoded and regex-scanned.
 * The extension is the honest gate.
 */
const IMPORT_SCAN_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "vue", "svelte",
]);

/**
 * Byte size of a changed path at HEAD, or undefined if it isn't one that
 * means anything — deleted at HEAD, or (the isFile() check) a non-regular
 * path. fs.statSync follows symlinks, so a changed path that is a symlink to
 * a character device or FIFO would otherwise stat at a small/zero size,
 * clearing both IMPORT_SCAN_MAX_BYTES and the extension gate in
 * collectSpecifiers, whose subsequent readFileSync(p, "utf8") could then
 * block forever or exhaust memory reading toward an EOF that never comes —
 * in a prep step that is not continue-on-error, taking the whole review job
 * down with it. Bounded by the fork guard (this needs an actor with write
 * access) but a one-line guard here is cheaper than reasoning about who has
 * write access on which repo. A rejected path is treated the same as a
 * deleted one: no entry, no read cost, still assigned to a reviewer at 0
 * bytes downstream.
 */
function statSize(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.size : undefined;
  } catch {
    return undefined;
  }
}

function read(name) {
  try {
    return fs.readFileSync(path.join(DIR, name), "utf8");
  } catch {
    return "";
  }
}

function main() {
  const numstat = read("numstat.txt");
  const diff = read("diff-headers.txt");
  const title = read("pr-title.txt").trim();

  const sizes = Object.create(null);
  for (const f of parseNumstat(numstat).files) {
    const size = statSize(f.path);
    if (size !== undefined) sizes[f.path] = size;
  }

  const reviewMode = process.env.REVIEW_MODE === "delta" ? "delta" : "full";
  const deltaBaseSha = process.env.DELTA_BASE_SHA || null;
  const priorHeadSha = process.env.PRIOR_HEAD_SHA || null;

  const manifest = buildManifest({
    baseSha: process.env.BASE_SHA || null,
    headSha: process.env.HEAD_SHA || null,
    numstat,
    diff,
    sizes,
    title,
    reviewMode,
    deltaBaseSha: deltaBaseSha || null,
    priorHeadSha: priorHeadSha || null,
  });

  atomicWriteJson(path.join(DIR, "manifest.json"), manifest);

  process.stdout.write(
    `prep: mode=${manifest.review_mode} ${manifest.file_count} files, churn ${manifest.churn}, ` +
      `${manifest.total_fullfile_bytes} bytes at HEAD, ` +
      `${manifest.symbol_manifest.length} symbols, ` +
      `title_ok=${manifest.title_ok}, ` +
      `no_tests_for_changed_logic=${manifest.no_tests_for_changed_logic}\n`,
  );

  writeRoster(manifest, sizes);
}

/**
 * Emit `.ai-review/assignments.json`.
 *
 * Fail-closed: Slice 3 routes the review model on `.k` and the review prompt
 * consumes the role list. A build or write failure is logged (including
 * scrapable `ai-review-roster` telemetry) then rethrown so the prep step exits
 * non-zero. Atomic write is preserved — a failed rename must not leave a
 * truncated assignments file.
 */
function writeRoster(manifest, sizes, io) {
  const readText = (io && io.readText) || ((p) => fs.readFileSync(p, "utf8"));
  const writeJson = (io && io.writeJson) || ((p, obj) => atomicWriteJson(p, obj));
  const log = (io && io.log) || ((line) => process.stdout.write(line));

  let roster = null;
  try {
    // Required inside the try so a load-time throw from roster.js is logged
    // with the same FAILED / telemetry / rethrow path as a build failure.
    const { buildRoster, resolveImportEdges } = require("./roster.js");

    const specifiers = collectSpecifiers(manifest.changed_files, sizes, readText);

    roster = buildRoster({
      files: manifest.changed_files.map((p) => ({ path: p, bytes: sizes[p] ?? 0 })),
      models: {
        opus: process.env.OPUS || "claude/claude-opus-5",
        sonnet: process.env.SONNET || "claude/claude-sonnet-5",
        // Helper tier (history/scorer): Task under Opus cannot use Haiku on
        // this gateway (adaptive thinking 400). Always Sonnet unless overridden.
        haiku: process.env.HELPER_MODEL || "claude/claude-sonnet-5",
      },
      importEdges: resolveImportEdges(specifiers, manifest.changed_files),
      symbolManifest: manifest.symbol_manifest,
      hasTestChange: manifest.has_test_change,
      hasLogicChange: manifest.has_logic_change,
      modifiesReviewerGuidance: manifest.modifies_reviewer_guidance,
    });

    writeJson(path.join(DIR, "assignments.json"), roster);

    log(
      `roster: K=${roster.k} over ${roster.changed_files.length} file(s); ` +
        `${roster.roles.map((r) => `${r.role}:${r.assigned_files.length}`).join(" ")}\n`,
    );
    // Name the limiter as precisely as the telemetry actually can — see
    // buildRoster's header for which of the three causes these two conditions
    // do and don't isolate. "clusters could not divide further" used to cover
    // every non-MAX_K case, which was flatly false for a file-count overflow:
    // splitOversized's per-cluster piece count doesn't know K, so a large
    // cluster CAN be cut finer than it was, the splitter just wasn't asked to.
    const { filesOver, any: isOverBudget } = overBudget(roster);
    if (isOverBudget) {
      // filesOver picks out the one axis that's separable (see buildRoster's
      // header); everything else — including a plain byte-axis overflow —
      // falls through to the "not distinguishable" case.
      const why = roster.k_capped
        ? `MAX_K bound at K=${roster.k}`
        : filesOver
          ? "file-count axis: cluster locality was kept over finer per-cluster splitting"
          : "byte axis: one indivisible file, or several atomic clusters that could not co-locate — not distinguishable from this telemetry alone";
      log(
        `roster: largest bin is over budget (${why}) — ` +
          `${roster.max_bin_bytes}/${roster.budget_bytes} bytes, ` +
          `${roster.max_bin_files}/${roster.budget_files} files\n`,
      );
    }
    if (roster.split_clusters.length > 0) {
      log(
        `roster: ${roster.split_clusters.length} cluster(s) split across reviewers; ` +
          `their internal edges belong to the tracer\n`,
      );
    }
    log(`${rosterTelemetry(roster)}\n`);
  } catch (err) {
    // buildRoster can succeed and writeJson can still throw — null the local
    // so telemetry says failed, then rethrow so prep fails closed.
    roster = null;
    // one(), like the two lines below it — a multi-line error message would
    // otherwise split this record across lines, the exact failure one()'s own
    // comment exists to prevent.
    log(`roster: FAILED — ${one(err)}\n`);
    log(
      `::error::ai-review could not build the review roster: ${one(err)}. ` +
        "Prep fails closed — Slice 3 routes on assignments.json.\n",
    );
    log(`${rosterTelemetry(null, err)}\n`);
    throw err;
  }
  return roster;
}

/** Collapse to a single line: a newline would split a scraped record in two. */
function one(v) {
  const s = v && v.message ? v.message : String(v);
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Per-file import specifiers, for the roster's third edge kind.
 *
 * @param {string[]} changedFiles
 * @param {Record<string, number>} sizes  path -> byte size at HEAD
 * @param {(path: string) => string} readText  injected so this is testable
 *   without a temp tree, and so the size gate and the skip paths are pinnable.
 */
function collectSpecifiers(changedFiles, sizes, readText) {
  // Lazy, matching writeRoster's require above — a load-time throw in
  // roster.js is handled by writeRoster's fail-closed path (log + rethrow).
  // Cheap: Node caches the module, so this is a second lookup, not a second load.
  const { extractImports } = require("./roster.js");
  const out = Object.create(null);
  for (const p of Array.isArray(changedFiles) ? changedFiles : []) {
    const size = sizes ? sizes[p] : undefined;
    // No size means the path is gone at HEAD; over the ceiling means a bundle or
    // a lockfile, which yields no useful adjacency and would dominate this step.
    // Either way the file is still assigned and still read in full by its
    // reviewer — only the clustering hint is skipped.
    if (size === undefined || size > IMPORT_SCAN_MAX_BYTES) continue;
    const dot = p.lastIndexOf(".");
    const slash = p.lastIndexOf("/");
    const ext = dot > slash + 1 ? p.slice(dot + 1).toLowerCase() : "";
    if (!IMPORT_SCAN_EXTS.has(ext)) continue;
    try {
      out[p] = extractImports(readText(p));
    } catch {
      // Vanished between stat and read, or unreadable. Falls back to directory
      // and test-pair edges — a weaker cluster, never a coverage gap.
    }
  }
  return out;
}

/**
 * Which axis, if either, put the largest bin over its budget — one pure
 * function called from both the job-log line and the scraped telemetry, so
 * the two cannot silently disagree about whether a run was over budget.
 */
function overBudget(roster) {
  const filesOver = roster.max_bin_files > roster.budget_files;
  const bytesOver = roster.max_bin_bytes > roster.budget_bytes;
  return { filesOver, bytesOver, any: filesOver || bytesOver };
}

/**
 * One scrapable line per run, in the `ai-review-metrics {json}` shape.
 *
 * Roster failures must be countable the same way as successes (the 682-job
 * latency baseline was gathered by grepping `ai-review-metrics {...}` out of
 * raw logs). Failure is a record, not a blank — absence and cleanliness must
 * never be the same byte pattern. Prep then exits non-zero (fail-closed).
 */
function rosterTelemetry(roster, err) {
  const payload = roster
    ? {
        status: "ok",
        k: roster.k,
        kCapped: roster.k_capped,
        files: roster.changed_files.length,
        splitClusters: roster.split_clusters.length,
        maxBinBytes: roster.max_bin_bytes,
        budgetBytes: roster.budget_bytes,
        maxBinFiles: roster.max_bin_files,
        budgetFiles: roster.budget_files,
        overBudget: overBudget(roster).any,
      }
    : { status: "failed", k: null, error: one(err) };
  return `ai-review-roster ${JSON.stringify(payload)}`;
}

module.exports = {
  IMPORT_SCAN_MAX_BYTES,
  statSize,
  collectSpecifiers,
  rosterTelemetry,
  atomicWriteJson,
  writeRoster,
  // Exported so a test can pin that main() actually calls writeRoster — every
  // other export here is well covered in isolation, but nothing previously
  // asserted the wiring between them: deleting the writeRoster() call inside
  // main() would keep every existing test green while assignments.json
  // silently stopped being emitted in production.
  main,
};

// `node lib/write-manifest.js` from the prep step runs it; `require()` from a
// test does not.
if (require.main === module) main();
