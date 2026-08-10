"use strict";

// Thin I/O wrapper around lib/prep.js — the only entry point that touches the
// filesystem, so the parsing itself stays pure and unit-tested.
//
// Reads (all produced by the prep step's git commands, all relative to the
// checked-out PR head):
//   .ai-review/numstat.txt       git diff --numstat <base> HEAD
//   .ai-review/diff-headers.txt  `diff --git` and `@@` lines only
//   .ai-review/pr-title.txt      PR title, fetched with gh
//
// Writes .ai-review/manifest.json and prints a one-line summary for the job log.
//
// Full-file sizes come from `fs.statSync` rather than `git cat-file -s`: the
// working tree is already checked out at HEAD, so a stat is both cheaper and
// exactly the byte count a reviewer reading the file will face. A deleted path
// has no entry and contributes 0.

const fs = require("node:fs");
const path = require("node:path");

const { buildManifest, parseNumstat } = require("./prep.js");

const DIR = ".ai-review";

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
}

main();
