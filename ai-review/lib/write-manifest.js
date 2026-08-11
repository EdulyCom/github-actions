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
// The roster is emitted on every run, including K=1, and nothing consumes it
// yet — the review stage is still serial. It is written now so the partition it
// asserts is exercised on real diffs, across all 7 consumers, before any model
// stage depends on it.

const fs = require("node:fs");
const path = require("node:path");

const { buildManifest, parseNumstat } = require("./prep.js");
const { buildRoster, extractImports, resolveImportEdges } = require("./roster.js");

const DIR = ".ai-review";

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
    try {
      sizes[f.path] = fs.statSync(f.path).size;
    } catch {
      // Deleted or renamed-away at HEAD; contributes no read cost.
    }
  }

  const manifest = buildManifest({
    baseSha: process.env.BASE_SHA || null,
    headSha: process.env.HEAD_SHA || null,
    numstat,
    diff,
    sizes,
    title,
  });

  fs.writeFileSync(
    path.join(DIR, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  process.stdout.write(
    `prep: ${manifest.file_count} files, churn ${manifest.churn}, ` +
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
 * Best-effort **for now, deliberately**: nothing consumes this file yet, so a
 * defect in brand-new roster code must not fail a review on seven consumer
 * repos that all track `@main`. The failure is named in the job log, never
 * swallowed — and it is the same shadow-mode discipline `lib/aggregate.js`
 * shipped under.
 *
 * When the review stage actually fans out, `assertPartition` becomes
 * load-bearing and this guard must be removed: at that point an unassigned file
 * is a file nobody reads, and continuing would be the fail-open the assertion
 * exists to prevent.
 */
function writeRoster(manifest, sizes, io) {
  const readText = (io && io.readText) || ((p) => fs.readFileSync(p, "utf8"));
  const writeJson = (io && io.writeJson) || ((p, obj) =>
    fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`));
  const log = (io && io.log) || ((line) => process.stdout.write(line));

  let roster = null;
  try {
    const specifiers = collectSpecifiers(manifest.changed_files, sizes, readText);

    roster = buildRoster({
      files: manifest.changed_files.map((p) => ({ path: p, bytes: sizes[p] ?? 0 })),
      models: {
        opus: process.env.OPUS || "claude-opus-5",
        sonnet: process.env.SONNET || "claude-sonnet-5",
        haiku: process.env.HAIKU || "claude-haiku-4-5",
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
    const filesOver = roster.max_bin_files > roster.budget_files;
    const bytesOver = roster.max_bin_bytes > roster.budget_bytes;
    if (bytesOver || filesOver) {
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
    // `roster` may already be a built object here — buildRoster can succeed and
    // writeJson can still throw. Null it out: the log line, the annotation and
    // the telemetry all say NOT EMITTED, and the return value has to agree.
    // Latent while main() is the only caller and ignores it; load-bearing once
    // PR-D/2 reads this to decide whether to fan out.
    roster = null;
    log(`roster: NOT EMITTED — ${err && err.message ? err.message : err}\n`);
    // An annotation as well as a log line: a `run:` step's stdout is not
    // surfaced anywhere a maintainer looks unless they open the job.
    log(
      `::warning::ai-review could not build the review roster: ${one(err)}. ` +
        "Nothing consumes it yet, so the review is unaffected — but PR-D/2 will.\n",
    );
    log(`${rosterTelemetry(null, err)}\n`);
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
 * One scrapable line per run, in the `ai-review-metrics {json}` shape.
 *
 * The case for shipping the roster before anything reads it rests entirely on
 * exercising the partition across seven consumers first. A lone unstructured
 * stdout line cannot carry that: the 682-job latency baseline was gathered by
 * grepping `ai-review-metrics {...}` out of raw logs, and a roster failure needs
 * to be countable the same way. A systematic `buildRoster` defect that produced
 * nothing aggregatable would hold for as long as nobody happened to open a job.
 *
 * Failure is a record, not a blank — absence and cleanliness must never be the
 * same byte pattern.
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
        overBudget:
          roster.max_bin_bytes > roster.budget_bytes ||
          roster.max_bin_files > roster.budget_files,
      }
    : { status: "failed", k: null, error: one(err) };
  return `ai-review-roster ${JSON.stringify(payload)}`;
}

module.exports = {
  IMPORT_SCAN_MAX_BYTES,
  collectSpecifiers,
  rosterTelemetry,
  writeRoster,
};

// `node lib/write-manifest.js` from the prep step runs it; `require()` from a
// test does not.
if (require.main === module) main();
