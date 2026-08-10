"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeK,
  clusterFiles,
  packClusters,
  splitOversized,
  assertPartition,
  extractImports,
  resolveImportEdges,
  buildRoster,
  BUDGET_BYTES,
} = require("./roster.js");

const f = (path, bytes) => ({ path, bytes });

// --- computeK (spec §5) ------------------------------------------------------
//
// K is a read budget, not a size cap. Fan-out activates only when the work
// exceeds what one reviewer can hold with full comprehension; below that, one
// reviewer IS the optimum and fan-out would add coordination cost for nothing.

test("computeK: small diffs collapse to a single reviewer", () => {
  assert.equal(computeK({ totalBytes: 1000, fileCount: 1 }), 1);
  assert.equal(computeK({ totalBytes: BUDGET_BYTES, fileCount: 5 }), 1);
});

test("computeK: scales with total full-file bytes", () => {
  assert.equal(computeK({ totalBytes: BUDGET_BYTES + 1, fileCount: 5 }), 2);
  assert.equal(computeK({ totalBytes: BUDGET_BYTES * 2.5, fileCount: 9 }), 3);
});

test("computeK: caps at 4 — rate-limit exposure, not an arbitrary number", () => {
  assert.equal(computeK({ totalBytes: BUDGET_BYTES * 50, fileCount: 500 }), 4);
});

test("computeK: many small files fan out even under the byte budget", () => {
  // Per-file attention costs something independent of total bytes (spec §5).
  assert.equal(computeK({ totalBytes: 1000, fileCount: 25 }), 2);
});

test("computeK: never returns 0 or a fraction", () => {
  for (const args of [
    { totalBytes: 0, fileCount: 0 },
    { totalBytes: -5, fileCount: 1 },
    { totalBytes: NaN, fileCount: NaN },
  ]) {
    const k = computeK(args);
    assert.ok(Number.isInteger(k) && k >= 1 && k <= 4, JSON.stringify(args));
  }
});

// --- clusterFiles (spec §4) --------------------------------------------------

test("clusterFiles: files in the same immediate directory join", () => {
  const cs = clusterFiles([f("src/a.ts", 10), f("src/b.ts", 10), f("docs/x.md", 10)]);
  assert.equal(cs.length, 2);
  assert.deepEqual(cs.find((c) => c.paths.includes("src/a.ts")).paths.sort(), ["src/a.ts", "src/b.ts"]);
});

test("clusterFiles: the edge is immediate-directory, not subtree", () => {
  // Joining on any shared prefix would collapse everything under `src/` into
  // one cluster on the most common diff shape there is.
  const cs = clusterFiles([f("src/a/x.ts", 10), f("src/b/y.ts", 10)]);
  assert.equal(cs.length, 2);
});

test("clusterFiles: a test pairs with the nearest source, not the first seen", () => {
  // The pair key is stem+ext with no directory component, so with two
  // same-named sources the tie has to break on path proximity or the edge
  // wires a test to an unrelated file in another package.
  const cs = clusterFiles([
    f("pkg-a/foo.ts", 10),
    f("pkg-b/foo.ts", 10),
    f("pkg-b/foo.test.ts", 10),
  ]);
  const withTest = cs.find((c) => c.paths.includes("pkg-b/foo.test.ts"));
  assert.ok(withTest.paths.includes("pkg-b/foo.ts"), "paired across packages");
  assert.ok(!withTest.paths.includes("pkg-a/foo.ts"));
});

test("clusterFiles: test<->source naming pairs join across directories", () => {
  const cs = clusterFiles([f("src/auth.ts", 10), f("test/auth.test.ts", 10)]);
  assert.equal(cs.length, 1);
});

test("clusterFiles: a lone file is its own cluster", () => {
  const cs = clusterFiles([f("a/x.ts", 1), f("b/y.ts", 1), f("c/z.ts", 1)]);
  assert.equal(cs.length, 3);
});

test("clusterFiles: cluster bytes are the sum of their files", () => {
  const cs = clusterFiles([f("src/a.ts", 30), f("src/b.ts", 12)]);
  assert.equal(cs[0].bytes, 42);
});

test("clusterFiles: two files with the same basename do NOT join", () => {
  // The test<->source edge needs one side to actually be a test. Without that
  // polarity check, every `index.ts` in the repo collapses into one cluster and
  // packing has nothing left to balance.
  const cs = clusterFiles([f("src/p1/x.ts", 10), f("src/p2/x.ts", 10)]);
  assert.equal(cs.length, 2);
});

test("clusterFiles: caller-supplied import edges join clusters", () => {
  // Import/require edges (spec §4 step 2) need file contents, which a pure
  // module does not have. The caller greps and passes the pairs in.
  const cs = clusterFiles(
    [f("src/a.ts", 10), f("lib/b.ts", 10)],
    [["src/a.ts", "lib/b.ts"]],
  );
  assert.equal(cs.length, 1);
});

test("clusterFiles: an import edge naming an unchanged file is ignored", () => {
  const cs = clusterFiles([f("src/a.ts", 10), f("lib/b.ts", 10)], [["src/a.ts", "vendor/z.ts"]]);
  assert.equal(cs.length, 2);
});

test("clusterFiles: empty input is safe", () => {
  assert.deepEqual(clusterFiles([]), []);
  assert.deepEqual(clusterFiles(null), []);
});

// --- packClusters ------------------------------------------------------------

test("packClusters: partition is exact — disjoint and complete", () => {
  const cs = clusterFiles([
    f("src/a.ts", 50), f("src/b.ts", 50), f("lib/c.ts", 40),
    f("docs/d.md", 10), f("api/e.ts", 70),
  ]);
  const bins = packClusters(cs, 3);
  const all = bins.flat().sort();
  assert.deepEqual(all, ["api/e.ts", "docs/d.md", "lib/c.ts", "src/a.ts", "src/b.ts"]);
  // pairwise disjoint
  const seen = new Set();
  for (const b of bins) for (const p of b) {
    assert.ok(!seen.has(p), `${p} appears twice`);
    seen.add(p);
  }
});

test("packClusters: first-fit-decreasing balances the largest first", () => {
  const cs = [
    { paths: ["big"], bytes: 100 },
    { paths: ["mid"], bytes: 60 },
    { paths: ["small"], bytes: 10 },
  ];
  const bins = packClusters(cs, 2);
  assert.deepEqual(bins[0], ["big"]);
  assert.deepEqual(bins[1].sort(), ["mid", "small"]);
});

test("packClusters: K=1 puts everything in one bin", () => {
  const cs = clusterFiles([f("src/a.ts", 10), f("lib/b.ts", 10)]);
  assert.deepEqual(packClusters(cs, 1).length, 1);
});

test("packClusters: never emits an empty bin", () => {
  const cs = clusterFiles([f("src/a.ts", 10)]);
  const bins = packClusters(cs, 4);
  assert.ok(bins.every((b) => b.length > 0));
  assert.equal(bins.length, 1);
});

// --- splitOversized (spec §4 step 4) -----------------------------------------
//
// Without this, the most common diff shape there is — every changed file in one
// directory — unions into a single cluster, `packClusters` has one thing to
// place, and K collapses to 1 no matter what `computeK` returned. The partition
// stays valid, so nothing catches it, and one reviewer silently holds the whole
// diff while the emitted `k` says otherwise.

test("splitOversized: a cluster over budget is split at file boundaries", () => {
  const big = { paths: ["a", "b", "c", "d"], bytes: BUDGET_BYTES * 2 };
  const out = splitOversized([{ ...big, sizes: { a: 70000, b: 70000, c: 70000, d: 70000 } }]);
  assert.ok(out.clusters.length > 1, "not split");
  assert.deepEqual(out.clusters.flatMap((c) => c.paths).sort(), ["a", "b", "c", "d"]);
});

test("splitOversized: each split piece stays under budget where it can", () => {
  const sizes = { a: 100000, b: 100000, c: 100000 };
  const out = splitOversized([{ paths: ["a", "b", "c"], bytes: 300000, sizes }]);
  for (const c of out.clusters) assert.ok(c.bytes <= BUDGET_BYTES, `${c.paths} = ${c.bytes}`);
});

test("splitOversized: a single file bigger than budget is never split", () => {
  // There is no byte-range field in the schema; a file is atomic by design.
  const out = splitOversized([{ paths: ["huge"], bytes: BUDGET_BYTES * 3, sizes: { huge: BUDGET_BYTES * 3 } }]);
  assert.equal(out.clusters.length, 1);
  assert.deepEqual(out.clusters[0].paths, ["huge"]);
});

test("splitOversized: a cluster under budget is untouched and unflagged", () => {
  const cs = [{ paths: ["a", "b"], bytes: 100, sizes: { a: 50, b: 50 } }];
  const out = splitOversized(cs);
  assert.equal(out.clusters.length, 1);
  assert.deepEqual(out.splitGroups, []);
});

test("splitOversized: split clusters are flagged for the tracer", () => {
  // Spec §4 step 4 — the tracer has to know that cluster's internal edges are
  // still its responsibility, because no reviewer holds them any more.
  const sizes = { a: 100000, b: 100000, c: 100000 };
  const out = splitOversized([{ paths: ["a", "b", "c"], bytes: 300000, sizes }]);
  assert.equal(out.splitGroups.length, 1);
  assert.deepEqual(out.splitGroups[0].sort(), ["a", "b", "c"]);
});

test("buildRoster: a one-directory diff still fans out", () => {
  // The reported regression, end to end: ten 100 KB files in one directory.
  const files = Array.from({ length: 10 }, (_, i) => f(`src/f${i}.ts`, 100000));
  const r = buildRoster({ files, models: { opus: "o", sonnet: "s", haiku: "h" } });
  assert.equal(r.k, 4, "collapsed to one reviewer");
  assert.equal(r.split_clusters.length, 1);
  const covered = r.roles.filter((x) => x.kind === "coverage").flatMap((x) => x.assigned_files);
  assert.deepEqual(covered.sort(), files.map((x) => x.path).sort());
});

// --- import edges (spec §4 step 2, third edge kind) --------------------------

test("extractImports: import, export-from and require all count", () => {
  const src = [
    `import { a } from "./a.js";`,
    `import b from '../lib/b';`,
    `export * from "./c";`,
    `const d = require("./d");`,
    `import "react";`,
  ].join("\n");
  assert.deepEqual(extractImports(src).sort(), ["../lib/b", "./a.js", "./c", "./d", "react"].sort());
});

test("extractImports: garbage never throws", () => {
  for (const bad of [null, undefined, 42, {}]) assert.deepEqual(extractImports(bad), []);
});

test("resolveImportEdges: a relative import of another changed file is an edge", () => {
  const edges = resolveImportEdges({ "src/a.ts": ["./b"] }, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(edges, [["src/a.ts", "src/b.ts"]]);
});

test("resolveImportEdges: '..' segments resolve", () => {
  const edges = resolveImportEdges({ "src/x/a.ts": ["../../lib/c"] }, ["src/x/a.ts", "lib/c.ts"]);
  assert.deepEqual(edges, [["src/x/a.ts", "lib/c.ts"]]);
});

test("resolveImportEdges: a directory specifier resolves through index", () => {
  const edges = resolveImportEdges({ "src/a.ts": ["./util"] }, ["src/a.ts", "src/util/index.ts"]);
  assert.deepEqual(edges, [["src/a.ts", "src/util/index.ts"]]);
});

test("resolveImportEdges: bare package specifiers are not edges", () => {
  assert.deepEqual(resolveImportEdges({ "src/a.ts": ["react", "@scope/pkg"] }, ["src/a.ts"]), []);
});

test("resolveImportEdges: an import of an unchanged file is not an edge", () => {
  // Edges are drawn among changed files only — the tracer, not the partition,
  // is what follows a relationship out of the diff.
  assert.deepEqual(resolveImportEdges({ "src/a.ts": ["./vendor"] }, ["src/a.ts"]), []);
});

test("resolveImportEdges: a file importing itself yields nothing", () => {
  assert.deepEqual(resolveImportEdges({ "src/a.ts": ["./a"] }, ["src/a.ts"]), []);
});

// --- assertPartition (spec §4 / §6 step 2) -----------------------------------
//
// Spec §4: "the prep step asserts the partition property — clusters pairwise
// disjoint, union equal to the full changed-file list — and hard-fails the job
// if violated." A file silently dropped from every bin is a file nobody reads,
// and the review would still report `verdict: pass`. That is the fail-open the
// assertion exists to make impossible.

test("assertPartition: an exact partition passes", () => {
  assert.doesNotThrow(() => assertPartition([["a"], ["b", "c"]], ["a", "b", "c"]));
});

test("assertPartition: a dropped file throws", () => {
  assert.throws(() => assertPartition([["a"], ["b"]], ["a", "b", "c"]), /unassigned/i);
});

test("assertPartition: a file in two bins throws", () => {
  assert.throws(() => assertPartition([["a", "b"], ["b"]], ["a", "b"]), /twice|disjoint/i);
});

test("assertPartition: a file nobody changed throws", () => {
  assert.throws(() => assertPartition([["a", "z"]], ["a"]), /not in changed_files/i);
});

test("assertPartition: an empty diff with no bins passes", () => {
  assert.doesNotThrow(() => assertPartition([], []));
});

// --- buildRoster -------------------------------------------------------------

test("buildRoster: OSH tiering — Opus orchestrates and frames, Sonnet reads, Haiku scores", () => {
  const r = buildRoster({
    files: [f("src/a.ts", 10)],
    models: { opus: "claude-opus-5", sonnet: "claude-sonnet-5", haiku: "claude-haiku-4-5" },
  });
  const by = Object.fromEntries(r.roles.map((x) => [x.role, x]));
  assert.equal(by["reviewer-1"].model, "claude-sonnet-5");
  assert.equal(by.tracer.model, "claude-sonnet-5");
  assert.equal(by.intent.model, "claude-opus-5");
  assert.equal(by.scorer.model, "claude-haiku-4-5");
});

test("buildRoster: only coverage roles hold files; the rest are assigned zero", () => {
  const r = buildRoster({
    files: [f("src/a.ts", 10), f("lib/b.ts", 10)],
    models: { opus: "o", sonnet: "s", haiku: "h" },
  });
  for (const role of r.roles) {
    if (role.kind === "coverage") assert.ok(role.assigned_files.length > 0, role.role);
    else assert.deepEqual(role.assigned_files, [], role.role);
  }
});

test("buildRoster: coverage roles partition changed_files exactly", () => {
  const files = Array.from({ length: 30 }, (_, i) => f(`src/p${i}/x.ts`, 20000));
  const r = buildRoster({ files, models: { opus: "o", sonnet: "s", haiku: "h" } });
  const covered = r.roles.filter((x) => x.kind === "coverage").flatMap((x) => x.assigned_files);
  assert.equal(covered.length, new Set(covered).size, "duplicate assignment");
  assert.deepEqual(covered.sort(), files.map((x) => x.path).sort());
});

test("buildRoster: K=1 collapses the roster, it does not branch the design", () => {
  const r = buildRoster({ files: [f("a.ts", 5)], models: { opus: "o", sonnet: "s", haiku: "h" } });
  assert.equal(r.roles.filter((x) => x.kind === "coverage").length, 1);
  // the non-coverage roles are still present — the shape does not change
  assert.ok(r.roles.some((x) => x.role === "intent"));
  assert.ok(r.roles.some((x) => x.role === "scorer"));
});

test("buildRoster: Haiku roles carry no effort — the API rejects it", () => {
  const r = buildRoster({ files: [f("a.ts", 5)], models: { opus: "o", sonnet: "s", haiku: "claude-haiku-4-5" } });
  for (const role of r.roles) {
    if (role.model === "claude-haiku-4-5") {
      assert.equal("effort" in role, false, `${role.role} must not set effort`);
    }
  }
});

test("buildRoster: effort is withheld from ANY role that lands on Haiku", () => {
  // The guard resolves against the model that actually runs, not the tier name,
  // so a consumer pointing sonnet-model at a Haiku id cannot reintroduce a
  // parameter the API rejects. Without this test, deleting the guard is free.
  const r = buildRoster({
    files: [f("a.ts", 5)],
    models: { opus: "claude-opus-5", sonnet: "claude-haiku-4-5", haiku: "claude-haiku-4-5" },
  });
  const by = Object.fromEntries(r.roles.map((x) => [x.role, x]));
  assert.equal("effort" in by["reviewer-1"], false, "reviewer-1 kept effort on Haiku");
  assert.equal("effort" in by.tracer, false, "tracer kept effort on Haiku");
  assert.equal(by.intent.effort, "high", "Opus role lost its effort");
});

test("buildRoster: an empty diff yields no coverage roles", () => {
  const r = buildRoster({ files: [], models: { opus: "o", sonnet: "s", haiku: "h" } });
  assert.equal(r.roles.filter((x) => x.kind === "coverage").length, 0);
});

test("buildRoster: output is JSON-serialisable and stable", () => {
  const args = { files: [f("src/a.ts", 10), f("src/b.ts", 20)], models: { opus: "o", sonnet: "s", haiku: "h" } };
  assert.deepEqual(
    JSON.parse(JSON.stringify(buildRoster(args))),
    JSON.parse(JSON.stringify(buildRoster(args))),
  );
});
