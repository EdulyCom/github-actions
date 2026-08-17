"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  statSize,
  collectSpecifiers,
  rosterTelemetry,
  atomicWriteJson,
  writeRoster,
  main,
  IMPORT_SCAN_MAX_BYTES,
} = require("./write-manifest.js");

// This module is the one entry point in ai-review/lib that touches the
// filesystem, and its header called itself a "thin I/O wrapper" as the reason it
// had no sibling test. `writeRoster` stretched that past the point where the
// claim held: the size gate, the specifiers map, the byte fallback and the
// fail-closed rethrow are all decisions, not plumbing. The I/O is injected so they
// can be pinned without a temp directory or a chdir.
//
// `main` is the one exception, deliberately: it is real fs.readFileSync /
// fs.writeFileSync against fixed relative paths, with no injection seam. A
// temp directory and a chdir are exactly what's needed to pin the one thing
// no other test here covers — that main() actually calls writeRoster.

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
// is injected so the fail-closed rethrow path is reachable without a temp
// directory or a chdir.

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
  assert.ok(!logs.some((l) => l.includes("FAILED")));
});

test("writeRoster: a buildRoster throw is logged then rethrown (fail-closed)", () => {
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
  assert.throws(
    () =>
      writeRoster(manifest, { "src/a.ts": 10 }, {
        readText: () => "",
        writeJson: (p, obj) => writes.push([p, obj]),
        log: (line) => logs.push(line),
      }),
    /assigned twice/,
  );
  assert.equal(writes.length, 0, "a failed build must never reach disk");
  assert.ok(logs.some((l) => l.startsWith("roster: FAILED")));
  assert.ok(logs.some((l) => l.startsWith("::error::")));
  assert.ok(logs.some((l) => l.startsWith("ai-review-roster {") && l.includes('"status":"failed"')));
});

test("writeRoster: a multi-line error message doesn't split the FAILED log line", () => {
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
  assert.throws(() =>
    writeRoster(manifest, { "src/a.ts": 10 }, {
      readText: () => "",
      writeJson: () => {
        throw new Error("line one\nline two\nline three");
      },
      log: (line) => logs.push(line),
    }),
  );
  const failed = logs.find((l) => l.startsWith("roster: FAILED"));
  assert.ok(failed, "no FAILED line found");
  assert.equal(failed.trimEnd().includes("\n"), false, `split across lines: ${JSON.stringify(failed)}`);
});

test("writeRoster: a throw from writeJson (build succeeded, the write didn't) fails closed", () => {
  // buildRoster can succeed and writeJson can still throw (disk full, bad path).
  // The catch logs FAILED / a ::error:: / status:"failed" telemetry, then
  // rethrows — prep must not continue without assignments.json.
  const logs = [];
  const manifest = {
    changed_files: ["src/a.ts"],
    symbol_manifest: [],
    has_test_change: false,
    has_logic_change: true,
    modifies_reviewer_guidance: false,
  };
  assert.throws(
    () =>
      writeRoster(manifest, { "src/a.ts": 10 }, {
        readText: () => "",
        writeJson: () => {
          throw new Error("ENOSPC");
        },
        log: (line) => logs.push(line),
      }),
    /ENOSPC/,
  );
  assert.ok(logs.some((l) => l.startsWith("roster: FAILED") && l.includes("ENOSPC")));
  assert.ok(logs.some((l) => l.startsWith("::error::")));
});

// The comment above the `why` ternary exists because a real miscategorisation
// shipped once already ("clusters could not divide further" logged for a
// file-count overflow that could, in fact, divide further). Each of these
// drives writeRoster over budget on a different axis and asserts the exact
// arm, so a future edit that silently swaps two branches fails here instead
// of shipping unnoticed a second time.

test("writeRoster: logs 'MAX_K bound' when the cap is what's actually binding", () => {
  const logs = [];
  const changed_files = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`);
  const sizes = Object.fromEntries(changed_files.map((p) => [p, 100000]));
  writeRoster(
    { changed_files, symbol_manifest: [], has_test_change: false, has_logic_change: true, modifies_reviewer_guidance: false },
    sizes,
    { readText: () => "", writeJson: () => {}, log: (l) => logs.push(l) },
  );
  const overBudgetLine = logs.find((l) => l.startsWith("roster: largest bin is over budget"));
  assert.ok(overBudgetLine, `no over-budget line: ${JSON.stringify(logs)}`);
  assert.match(overBudgetLine, /MAX_K bound at K=4/);
});

test("writeRoster: logs the file-count axis when clusters can't divide further", () => {
  const logs = [];
  const changed_files = [
    ...Array.from({ length: 30 }, (_, i) => `a/f${i}.ts`),
    ...Array.from({ length: 30 }, (_, i) => `b/f${i}.ts`),
  ];
  const sizes = Object.fromEntries(changed_files.map((p) => [p, 1000]));
  writeRoster(
    { changed_files, symbol_manifest: [], has_test_change: false, has_logic_change: true, modifies_reviewer_guidance: false },
    sizes,
    { readText: () => "", writeJson: () => {}, log: (l) => logs.push(l) },
  );
  const overBudgetLine = logs.find((l) => l.startsWith("roster: largest bin is over budget"));
  assert.ok(overBudgetLine, `no over-budget line: ${JSON.stringify(logs)}`);
  assert.match(overBudgetLine, /file-count axis/);
});

test("writeRoster: logs the byte axis when one indivisible file is the limiter", () => {
  const logs = [];
  writeRoster(
    { changed_files: ["src/huge.ts"], symbol_manifest: [], has_test_change: false, has_logic_change: true, modifies_reviewer_guidance: false },
    { "src/huge.ts": 600000 },
    { readText: () => "", writeJson: () => {}, log: (l) => logs.push(l) },
  );
  const overBudgetLine = logs.find((l) => l.startsWith("roster: largest bin is over budget"));
  assert.ok(overBudgetLine, `no over-budget line: ${JSON.stringify(logs)}`);
  assert.match(overBudgetLine, /byte axis/);
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
  assert.ok(!logs.some((l) => l.includes("FAILED")));
});

// --- atomicWriteJson ----------------------------------------------------------
//
// On a write failure writeRoster logs then rethrows (fail-closed). A bare
// fs.writeFileSync could still leave a truncated assignments.json on disk
// after prep already failed. Real files on a real temp directory, not mocks:
// the property under test is what actually lands on disk after a failure.

test("atomicWriteJson: writes the JSON, then removes the temp file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
  const target = path.join(dir, "out.json");
  try {
    atomicWriteJson(target, { k: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { k: 1 });
    assert.deepEqual(fs.readdirSync(dir), ["out.json"], "temp file left behind");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWriteJson: a failure never leaves a partial file at the target path", () => {
  // The injected writeFile writes REAL, PARTIAL bytes to whatever path it's
  // given before throwing — simulating an ENOSPC mid-write — rather than
  // throwing before touching disk at all. A mock that never writes anything
  // would pass this test whether the implementation targets a temp file or
  // the real target directly, since nothing on disk changes either way; only
  // a real partial write can tell the two apart. Confirmed to fail against a
  // regressed direct-write implementation (no temp file, no rename): the
  // partial bytes land on `target` itself, corrupting it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
  const target = path.join(dir, "out.json");
  fs.writeFileSync(target, "PREVIOUS GOOD CONTENT");
  try {
    assert.throws(() => {
      atomicWriteJson(target, { k: 1 }, {
        writeFile: (p, content) => {
          fs.writeFileSync(p, content.slice(0, 3)); // a real, truncated write
          throw new Error("ENOSPC");
        },
      });
    });
    // The partial bytes landed on the TEMP path, not the target — the target
    // is exactly what it was before, never truncated, never a mix of old and
    // new content.
    assert.equal(fs.readFileSync(target, "utf8"), "PREVIOUS GOOD CONTENT");
    assert.deepEqual(fs.readdirSync(dir), ["out.json"], "the partial temp file was not cleaned up");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWriteJson: a rename failure leaves the old target untouched and cleans up the temp file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
  const target = path.join(dir, "out.json");
  fs.writeFileSync(target, "PREVIOUS GOOD CONTENT");
  try {
    assert.throws(() => {
      atomicWriteJson(target, { k: 1 }, {
        renameFile: () => {
          throw new Error("EPERM");
        },
      });
    });
    assert.equal(fs.readFileSync(target, "utf8"), "PREVIOUS GOOD CONTENT");
    assert.deepEqual(fs.readdirSync(dir), ["out.json"], "the temp file was not cleaned up");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- main ----------------------------------------------------------------
//
// Real fs, real cwd, no injection seam — that is exactly the wiring the other
// tests in this file cannot pin. Deleting the writeRoster() call inside main()
// would keep every other test in this file green while assignments.json
// silently stopped being emitted in production; this is the test that fails.

test("main: writes manifest.json AND assignments.json against a real diff on disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "write-manifest-main-"));
  const prevCwd = process.cwd();
  const prevBase = process.env.BASE_SHA;
  const prevHead = process.env.HEAD_SHA;
  const prevMode = process.env.REVIEW_MODE;
  const prevDelta = process.env.DELTA_BASE_SHA;
  const prevPrior = process.env.PRIOR_HEAD_SHA;
  // Spies on the real fs.renameSync so this test proves the DEFAULT wiring --
  // main() -> writeRoster()/manifest write -> atomicWriteJson -> fs.renameSync
  // -- actually runs in production, not just that atomicWriteJson behaves
  // correctly when called directly (already covered above) or that the end
  // file happens to look right (which a reverted bare fs.writeFileSync would
  // also produce on the happy path -- the two are indistinguishable from the
  // output alone, only the syscall sequence tells them apart). Every other
  // test in this file injects its own writeJson, so nothing else exercises
  // this specific wire.
  const renamed = [];
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    renamed.push(to);
    return realRename(from, to);
  };
  try {
    process.chdir(dir);
    fs.mkdirSync(".ai-review");
    fs.writeFileSync(".ai-review/numstat.txt", "3\t1\tsrc/a.ts\n");
    fs.writeFileSync(
      ".ai-review/diff-headers.txt",
      "diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,3 @@ export function widget() {\n",
    );
    fs.writeFileSync(".ai-review/pr-title.txt", "feat(x): add widget\n");
    fs.mkdirSync("src");
    fs.writeFileSync("src/a.ts", "export function widget() {\n  return 1;\n}\n");
    process.env.BASE_SHA = "base000";
    process.env.HEAD_SHA = "head111";
    process.env.REVIEW_MODE = "delta";
    process.env.DELTA_BASE_SHA = "prior222";
    process.env.PRIOR_HEAD_SHA = "prior222";

    main();

    const manifest = JSON.parse(fs.readFileSync(".ai-review/manifest.json", "utf8"));
    assert.equal(manifest.schema, 1);
    assert.deepEqual(manifest.changed_files, ["src/a.ts"]);
    assert.equal(manifest.base_sha, "base000");
    assert.equal(manifest.head_sha, "head111");
    assert.equal(manifest.review_mode, "delta");
    assert.equal(manifest.delta_base_sha, "prior222");
    assert.equal(manifest.prior_head_sha, "prior222");

    const roster = JSON.parse(fs.readFileSync(".ai-review/assignments.json", "utf8"));
    assert.equal(roster.schema, 1);
    assert.deepEqual(roster.changed_files, ["src/a.ts"]);
    const coverage = roster.roles.filter((r) => r.kind === "coverage");
    assert.deepEqual(coverage.flatMap((r) => r.assigned_files), ["src/a.ts"]);

    assert.deepEqual(
      renamed.sort(),
      [path.join(".ai-review", "assignments.json"), path.join(".ai-review", "manifest.json")].sort(),
      "manifest.json and/or assignments.json did not go through the atomic write path",
    );
    assert.deepEqual(
      fs.readdirSync(".ai-review").filter((f) => f.includes(".tmp-")),
      [],
      "a temp file was left behind in .ai-review",
    );
  } finally {
    fs.renameSync = realRename;
    process.chdir(prevCwd);
    if (prevBase === undefined) delete process.env.BASE_SHA;
    else process.env.BASE_SHA = prevBase;
    if (prevHead === undefined) delete process.env.HEAD_SHA;
    else process.env.HEAD_SHA = prevHead;
    if (prevMode === undefined) delete process.env.REVIEW_MODE;
    else process.env.REVIEW_MODE = prevMode;
    if (prevDelta === undefined) delete process.env.DELTA_BASE_SHA;
    else process.env.DELTA_BASE_SHA = prevDelta;
    if (prevPrior === undefined) delete process.env.PRIOR_HEAD_SHA;
    else process.env.PRIOR_HEAD_SHA = prevPrior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


// --- statSize -----------------------------------------------------------------
//
// Isolates the guard from the read path entirely, on purpose: proving the real
// risk (a hang or OOM reading a character device or FIFO) would mean putting a
// hang-prone device in a test, which defeats the point of having a test suite.
// /dev/null is harmless to read either way — it stats at size 0 and reads
// return EOF instantly, so a main()-level integration test using it produced
// byte-identical manifest.json/assignments.json output whether the guard
// existed or not, and did not actually discriminate. Testing statSize directly
// proves the GUARD's own logic — a non-regular path is excluded, not reported
// as 0 bytes — without needing anything that could hang.

test("statSize: a symlink to a non-regular file is excluded, not reported as 0 bytes", () => {
  if (process.platform === "win32" || !fs.existsSync("/dev/null")) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statsize-"));
  const link = path.join(dir, "weird.js");
  try {
    fs.symlinkSync("/dev/null", link);
    assert.equal(statSize(link), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("statSize: a regular file reports its real byte size", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statsize-"));
  const file = path.join(dir, "a.ts");
  try {
    fs.writeFileSync(file, "hello");
    assert.equal(statSize(file), 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("statSize: a missing path is undefined, the same as a deleted-at-HEAD path", () => {
  assert.equal(statSize("/nonexistent/path/that/does/not/exist.ts"), undefined);
});

test("statSize: a directory is excluded too, not reported as some directory-entry size", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statsize-"));
  try {
    assert.equal(statSize(dir), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
