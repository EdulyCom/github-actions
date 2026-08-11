"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  collectSpecifiers,
  rosterTelemetry,
  writeRoster,
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

test("collectSpecifiers: a file that fails to read is skipped, never fatal", () => {
  // Vanished between stat and read, or a permission error. Falls back to
  // directory and test-pair edges — a weaker cluster, never a coverage gap.
  const read = (p) => {
    if (p === "bad.ts") throw new Error("ENOENT");
    return `require("./x")`;
  };
  const out = collectSpecifiers(["bad.ts", "ok.ts"], { "bad.ts": 10, "ok.ts": 10 }, read);
  assert.equal("bad.ts" in out, false);
  assert.deepEqual(out["ok.ts"], ["./x"]);
});

test("collectSpecifiers: binary is skipped by extension, not by hoping read throws", () => {
  // The catch above was documented as covering binary, but the production reader
  // is readFileSync(p, "utf8"), which substitutes U+FFFD for invalid sequences
  // rather than throwing. A changed 200 KB PNG is under the size ceiling, so it
  // was decoded and regex-scanned. extractImports is JS/TS-only by construction,
  // so the extension is the honest gate.
  let opened = [];
  const read = (p) => {
    opened.push(p);
    return "";
  };
  collectSpecifiers(
    ["logo.png", "notes.md", "src/a.ts", "src/b.mjs", "Makefile"],
    { "logo.png": 200000, "notes.md": 10, "src/a.ts": 10, "src/b.mjs": 10, Makefile: 10 },
    read,
  );
  assert.deepEqual(opened.sort(), ["src/a.ts", "src/b.mjs"]);
});

// --- writeRoster --------------------------------------------------------------
//
// The success path is exercised end to end in ai-review/action.yml against a
// real repo (see the commit history); these pin the wiring around it — the I/O
// is injected so the best-effort catch is reachable without a temp directory or
// a chdir.

test("writeRoster: writes assignments.json and logs a summary on success", () => {
  const writes = [];
  const logs = [];
  const manifest = {
    changed_files: ["src/a.ts", "src/b.ts"],
    symbol_manifest: [],
    has_test_change: true,
    has_logic_change: true,
    modifies_reviewer_guidance: false,
  };
  const roster = writeRoster(manifest, { "src/a.ts": 100, "src/b.ts": 200 }, {
    readText: () => "",
    writeJson: (p, obj) => writes.push([p, obj]),
    log: (line) => logs.push(line),
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], ".ai-review/assignments.json");
  assert.equal(writes[0][1].k, roster.k);
  assert.ok(logs.some((l) => l.startsWith("roster: K=")));
  assert.ok(logs.some((l) => l.startsWith("ai-review-roster {")));
  assert.ok(!logs.some((l) => l.includes("NOT EMITTED")));
});

test("writeRoster: a buildRoster throw is caught, logged, and never written", () => {
  // Duplicate changed_files entries make buildRoster's own assertPartition
  // throw ("assigned twice") — a real failure mode, not a synthetic one, since
  // a caller could hand this a manifest with a duplicated path.
  const writes = [];
  const logs = [];
  const manifest = {
    changed_files: ["src/a.ts", "src/a.ts"],
    symbol_manifest: [],
    has_test_change: false,
    has_logic_change: true,
    modifies_reviewer_guidance: false,
  };
  const result = writeRoster(manifest, { "src/a.ts": 10 }, {
    readText: () => "",
    writeJson: (p, obj) => writes.push([p, obj]),
    log: (line) => logs.push(line),
  });
  assert.equal(result, null);
  assert.equal(writes.length, 0, "a failed build must never reach disk");
  assert.ok(logs.some((l) => l.startsWith("roster: NOT EMITTED")));
  assert.ok(logs.some((l) => l.startsWith("::warning::")));
  assert.ok(logs.some((l) => l.startsWith("ai-review-roster {") && l.includes('"status":"failed"')));
});

test("writeRoster: a multi-line error message doesn't split the NOT EMITTED log line", () => {
  // The other two lines in this catch already went through one(); this one
  // didn't, so a multi-line error would break a scraper reading the log
  // line-by-line — the exact failure one()'s own comment describes.
  const logs = [];
  // A single valid path, not a duplicate — buildRoster must succeed so it is
  // writeJson's throw, not assertPartition's, that reaches this catch.
  const manifest = {
    changed_files: ["src/a.ts"],
    symbol_manifest: [],
    has_test_change: false,
    has_logic_change: true,
    modifies_reviewer_guidance: false,
  };
  writeRoster(manifest, { "src/a.ts": 10 }, {
    readText: () => "",
    writeJson: () => {
      throw new Error("line one\nline two\nline three");
    },
    log: (line) => logs.push(line),
  });
  const notEmitted = logs.find((l) => l.startsWith("roster: NOT EMITTED"));
  assert.ok(notEmitted, "no NOT EMITTED line found");
  assert.equal(notEmitted.trimEnd().includes("\n"), false, `split across lines: ${JSON.stringify(notEmitted)}`);
});

test("writeRoster: a throw from writeJson (build succeeded, the write didn't) returns null too", () => {
  // buildRoster can succeed and writeJson can still throw (disk full, bad path).
  // The catch logs NOT EMITTED / a ::warning:: / status:"failed" telemetry in
  // every case — the return value has to agree, or a caller reading it back
  // would get a fully-built roster object for a run the log just called a
  // failure.
  const logs = [];
  const manifest = {
    changed_files: ["src/a.ts"],
    symbol_manifest: [],
    has_test_change: false,
    has_logic_change: true,
    modifies_reviewer_guidance: false,
  };
  const result = writeRoster(manifest, { "src/a.ts": 10 }, {
    readText: () => "",
    writeJson: () => {
      throw new Error("ENOSPC");
    },
    log: (line) => logs.push(line),
  });
  assert.equal(result, null, "a write failure must not return a built roster");
  assert.ok(logs.some((l) => l.startsWith("roster: NOT EMITTED") && l.includes("ENOSPC")));
});

test("writeRoster: a readText throw for one file degrades to a weaker cluster, not a failure", () => {
  const logs = [];
  const manifest = {
    changed_files: ["src/a.ts", "src/b.ts"],
    symbol_manifest: [],
    has_test_change: false,
    has_logic_change: true,
    modifies_reviewer_guidance: false,
  };
  const result = writeRoster(manifest, { "src/a.ts": 10, "src/b.ts": 10 }, {
    readText: (p) => {
      if (p === "src/a.ts") throw new Error("EACCES");
      return "";
    },
    writeJson: () => {},
    log: (line) => logs.push(line),
  });
  assert.notEqual(result, null);
  assert.ok(!logs.some((l) => l.includes("NOT EMITTED")));
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
