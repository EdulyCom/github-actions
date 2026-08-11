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
function writeRoster(manifest, sizes) {
  try {
    const specifiers = Object.create(null);
    for (const p of manifest.changed_files) {
      const size = sizes[p];
      if (size === undefined || size > IMPORT_SCAN_MAX_BYTES) continue;
      try {
        specifiers[p] = extractImports(fs.readFileSync(p, "utf8"));
      } catch {
        // Binary, unreadable, or gone. Falls back to directory and test-pair
        // edges — a weaker cluster, never a coverage gap.
      }
    }

    const roster = buildRoster({
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

    fs.writeFileSync(
      path.join(DIR, "assignments.json"),
      `${JSON.stringify(roster, null, 2)}\n`,
    );

    process.stdout.write(
      `roster: K=${roster.k} over ${roster.changed_files.length} file(s); ` +
        `${roster.roles.map((r) => `${r.role}:${r.assigned_files.length}`).join(" ")}\n`,
    );
    if (roster.k_capped) {
      // Deliberate, not a defect: MAX_K is rate-limit exposure. Logged so a slow
      // reviewer stage on a huge diff is explainable from the job log alone.
      process.stdout.write(
        `roster: MAX_K bound — largest bin is ${roster.max_bin_bytes} bytes ` +
          `against a ${roster.budget_bytes}-byte per-reviewer budget\n`,
      );
    }
    if (roster.split_clusters.length > 0) {
      process.stdout.write(
        `roster: ${roster.split_clusters.length} cluster(s) split across reviewers; ` +
          `their internal edges belong to the tracer\n`,
      );
    }
  } catch (err) {
    process.stdout.write(`roster: NOT EMITTED — ${err && err.message ? err.message : err}\n`);
  }
}

main();
