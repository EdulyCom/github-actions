"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  collectSpecifiers,
  rosterTelemetry,
  IMPORT_SCAN_MAX_BYTES,
} = require("./write-manifest.js");

// This module is the one entry point in ai-review/lib that touches the
// filesystem, and its header called itself a "thin I/O wrapper" as the reason it
// had no sibling test. `writeRoster` stretched that past the point where the
// claim held: the size gate, the specifiers map, the byte fallback and the
// best-effort catch are all decisions, not plumbing. The I/O is injected so they
// can be pinned without a temp directory or a chdir.

// --- collectSpecifiers -------------------------------------------------------

test("collectSpecifiers: extracts import specifiers per changed file", () => {
  const read = (p) => ({ "src/a.ts": `import x from "./b";`, "src/b.ts": "" })[p];
  const out = collectSpecifiers(["src/a.ts", "src/b.ts"], { "src/a.ts": 100, "src/b.ts": 10 }, read);
  assert.deepEqual(out["src/a.ts"], ["./b"]);
  assert.deepEqual(out["src/b.ts"], []);
});

test("collectSpecifiers: skips files above the scan ceiling", () => {
  // A minified bundle or a lockfile yields no useful adjacency and would
  // dominate this step. It is still stat'd, still assigned, still read in full
  // by its reviewer — only the clustering hint is skipped.
  let opened = 0;
  const read = () => {
    opened += 1;
    return "";
  };
  const out = collectSpecifiers(
    ["big.js"],
    { "big.js": IMPORT_SCAN_MAX_BYTES + 1 },
    read,
  );
  assert.equal(opened, 0);
  assert.equal("big.js" in out, false);
});

test("collectSpecifiers: skips a path with no recorded size (deleted at HEAD)", () => {
  let opened = 0;
  const out = collectSpecifiers(["gone.ts"], {}, () => {
    opened += 1;
    return "";
  });
  assert.equal(opened, 0);
  assert.deepEqual(Object.keys(out), []);
});

test("collectSpecifiers: an unreadable file is skipped, never fatal", () => {
  // Binary, or vanished between stat and read. Falls back to directory and
  // test-pair edges — a weaker cluster, never a coverage gap.
  const read = (p) => {
    if (p === "bad.ts") throw new Error("EILSEQ");
    return `require("./x")`;
  };
  const out = collectSpecifiers(["bad.ts", "ok.ts"], { "bad.ts": 10, "ok.ts": 10 }, read);
  assert.equal("bad.ts" in out, false);
  assert.deepEqual(out["ok.ts"], ["./x"]);
});

// --- rosterTelemetry ---------------------------------------------------------
//
// The whole argument for shipping the roster before anything consumes it is that
// the partition gets exercised on real diffs across every consumer first. A lone
// unstructured stdout line does not survive that: `ai-review-metrics {json}` is
// how the 682-job baseline was scraped, so the roster needs the same shape or a
// systematic failure is invisible at fleet scale for as long as it lasts.

test("rosterTelemetry: a successful roster reports its budgets and maxima", () => {
  const line = rosterTelemetry({
    k: 2,
    changed_files: ["a", "b"],
    split_clusters: [["a", "b"]],
    budget_bytes: 1000,
    max_bin_bytes: 900,
    budget_files: 20,
    max_bin_files: 1,
    k_capped: false,
  });
  const parsed = JSON.parse(line.slice(line.indexOf("{")));
  assert.equal(line.startsWith("ai-review-roster {"), true);
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.k, 2);
  assert.equal(parsed.files, 2);
  assert.equal(parsed.splitClusters, 1);
  assert.equal(parsed.overBudget, false);
});

test("rosterTelemetry: over budget on EITHER axis is flagged", () => {
  const base = {
    k: 4, changed_files: ["a"], split_clusters: [],
    budget_bytes: 1000, budget_files: 20, k_capped: false,
  };
  const bytes = JSON.parse(rosterTelemetry({ ...base, max_bin_bytes: 2000, max_bin_files: 1 }).replace(/^\S+ /, ""));
  const count = JSON.parse(rosterTelemetry({ ...base, max_bin_bytes: 10, max_bin_files: 30 }).replace(/^\S+ /, ""));
  assert.equal(bytes.overBudget, true);
  assert.equal(count.overBudget, true);
});

test("rosterTelemetry: a failure is a data point, not a blank", () => {
  // Absence and cleanliness must never be the same byte pattern — the same
  // principle aggregate.js is built on, applied to its own telemetry.
  const line = rosterTelemetry(null, new Error("assertPartition: src/x.ts unassigned"));
  const parsed = JSON.parse(line.slice(line.indexOf("{")));
  assert.equal(parsed.status, "failed");
  assert.match(parsed.error, /unassigned/);
  assert.equal(parsed.k, null);
});

test("rosterTelemetry: output is one line — a newline would split the scrape", () => {
  const line = rosterTelemetry(null, new Error("line one\nline two"));
  assert.equal(line.includes("\n"), false);
});
