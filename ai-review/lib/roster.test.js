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
  FILES_PER_REVIEWER,
} = require("./roster.js");
const { FRAME_ROLE } = require("./aggregate.js");

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

test("packClusters: least-loaded greedy places the largest cluster first", () => {
  // Deliberately NOT first-fit-decreasing: at fixed K with no per-bin capacity
  // nothing can fail to fit, so literal first-fit piles everything into bin 0.
  // The name matters more than the body here — this assertion would pass under
  // several wrong packers, so a name pointing at the algorithm the code exists
  // to avoid is the misleading part.
  const cs = [
    { paths: ["big"], bytes: 100 },
    { paths: ["mid"], bytes: 60 },
    { paths: ["small"], bytes: 10 },
  ];
  const bins = packClusters(cs, 2);
  assert.deepEqual(bins[0], ["big"]);
  assert.deepEqual(bins[1].sort(), ["mid", "small"]);
});

test("packClusters: clusters are ORDERED by the same blended cost they are placed by", () => {
  // Decreasing-greedy only bounds imbalance when items are ordered by the cost
  // used to place them. Placement was blended; the sort was left on bytes, so a
  // large zero-byte cluster sorted LAST and landed on whichever bin was already
  // occupied. 20 deletions plus two edits gave [1, 21] — over the file budget —
  // while [20, 2] was legal on both axes and never considered.
  const cs = [
    { paths: Array.from({ length: 20 }, (_, i) => `del${i}`), bytes: 0 },
    { paths: ["edit-big"], bytes: 40000 },
    { paths: ["edit-small"], bytes: 10000 },
  ];
  const bins = packClusters(cs, 2);
  assert.deepEqual(bins.map((b) => b.length).sort((a, b) => a - b), [2, 20]);
});

test("buildRoster: 20 deletions plus two edits stays inside the file budget", () => {
  const files = [
    ...Array.from({ length: 20 }, (_, i) => f(`src/legacy/d${i}.ts`, 0)),
    f("src/app.ts", 40000),
    f("lib/util.ts", 10000),
  ];
  const r = buildRoster({ files, models: { opus: "o", sonnet: "s", haiku: "h" } });
  assert.ok(r.max_bin_files <= FILES_PER_REVIEWER, `max_bin_files=${r.max_bin_files}`);
  const covered = r.roles.filter((x) => x.kind === "coverage").flatMap((x) => x.assigned_files);
  assert.deepEqual(covered.sort(), files.map((x) => x.path).sort());
});

test("buildRoster: k_capped is false when raising MAX_K would change nothing", () => {
  // One indivisible 600 KB file plus three small clusters: uncappedK is 5 and
  // bins reach MAX_K, but there are only 4 pieces to place, so a higher cap
  // would produce the identical roster. Reporting "MAX_K bound" sends whoever
  // reads the telemetry to raise a cap that is not the constraint.
  const r = buildRoster({
    files: [f("src/huge.ts", 600000), f("a/x.ts", 10), f("b/y.ts", 10), f("c/z.ts", 10)],
    models: { opus: "o", sonnet: "s", haiku: "h" },
  });
  assert.equal(r.k, 4);
  assert.equal(r.k_capped, false);
});

test("packClusters: budgets are parameters, symmetric with splitOversized", () => {
  // Both are exported. splitOversized takes budget/maxFiles; packClusters used
  // to divide by the module constants directly, so a caller who tuned the split
  // down and then packed would get pieces sized for their budget and a balance
  // scored against 130 KB / 20 files, with no error and no log line.
  const cs = [
    { paths: ["heavy"], bytes: 100000 },
    { paths: Array.from({ length: 10 }, (_, i) => `m${i}`), bytes: 0 },
    { paths: ["z"], bytes: 0 },
  ];
  // Under the module defaults, `heavy` dominates on bytes and `z` joins the
  // 10-file bin: [1, 11].
  assert.deepEqual(
    packClusters(cs, 2).map((b) => b.length).sort((a, b) => a - b),
    [1, 11],
  );
  // Under a budget where bytes are nearly free and files are dear, the 10-file
  // cluster is the expensive one and `z` joins `heavy` instead: [2, 10].
  assert.deepEqual(
    packClusters(cs, 2, 1e9, 4).map((b) => b.length).sort((a, b) => a - b),
    [2, 10],
  );
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

test("splitOversized: placement is blended too, not bytes-first like the packer used to be", () => {
  // packClusters was fixed twice for this exact rule (a piece holding any bytes
  // loses every tie to an all-zero piece); splitOversized still picked pieces on
  // raw bytes. One edit plus 44 deletions, K=3: the byte-carrying file opened
  // piece0, every zero-byte file then beat it on `piece.bytes < best.bytes`, so
  // piece1/piece2 filled to capFiles before piece0 got another one, and the
  // last 4 spilled back onto piece0 -> [20, 20, 5]. [15,15,15] was reachable and
  // never found — silently, since max_bin_files landed exactly on budget_files.
  const paths = ["edit", ...Array.from({ length: 44 }, (_, i) => `del${i}`)];
  const sizes = { edit: 1000, ...Object.fromEntries(paths.slice(1).map((p) => [p, 0])) };
  const out = splitOversized([{ paths, bytes: 1000, sizes }], BUDGET_BYTES, FILES_PER_REVIEWER);
  const sizesOf = out.clusters.map((c) => c.paths.length).sort((a, b) => a - b);
  assert.deepEqual(sizesOf, [15, 15, 15]);
});

test("buildRoster: one edit plus 44 deletions balances instead of hitting the budget silently", () => {
  const files = [
    f("src/edit.ts", 1000),
    ...Array.from({ length: 44 }, (_, i) => f(`src/legacy${i}.ts`, 0)),
  ];
  const r = buildRoster({ files, models: { opus: "o", sonnet: "s", haiku: "h" } });
  assert.equal(r.k, 3);
  const bins = r.roles.filter((x) => x.kind === "coverage").map((x) => x.assigned_files.length);
  assert.deepEqual(bins.slice().sort((a, b) => a - b), [15, 15, 15]);
  const covered = r.roles.filter((x) => x.kind === "coverage").flatMap((x) => x.assigned_files);
  assert.deepEqual(covered.sort(), files.map((x) => x.path).sort());
});

test("splitOversized: a cluster over the FILE COUNT budget is also split", () => {
  // The byte axis was the only one guarded, so `FILES_PER_REVIEWER` — the whole
  // reason computeK has a count term (spec §5) — could never reach the emitted
  // roster: 25 tiny files in one directory union into one cluster, sail under
  // the byte cap, and clamp the packer to a single bin.
  const paths = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`);
  const sizes = Object.fromEntries(paths.map((p) => [p, 2000]));
  const out = splitOversized([{ paths, bytes: 50000, sizes }]);
  assert.ok(out.clusters.length > 1, "not split on count");
  for (const c of out.clusters) assert.ok(c.paths.length <= FILES_PER_REVIEWER, `${c.paths.length}`);
  assert.deepEqual(out.clusters.flatMap((c) => c.paths).sort(), paths.slice().sort());
});

test("buildRoster: 25 small files in one directory fan out, evenly", () => {
  const files = Array.from({ length: 25 }, (_, i) => f(`src/f${i}.ts`, 2000));
  const r = buildRoster({ files, models: { opus: "o", sonnet: "s", haiku: "h" } });
  assert.equal(r.k, 2, "count axis never reached the roster");
  // Not 20/5. Parallel wall-clock is max() not sum(), so a legal-but-lopsided
  // split throws away most of the win the fan-out exists for.
  const bins = r.roles.filter((x) => x.kind === "coverage").map((x) => x.assigned_files.length);
  assert.deepEqual(bins.slice().sort(), [12, 13]);
  const covered = r.roles.filter((x) => x.kind === "coverage").flatMap((x) => x.assigned_files);
  assert.deepEqual(covered.sort(), files.map((x) => x.path).sort());
});

test("buildRoster: a delete-only diff fans out even though every file is 0 bytes", () => {
  // `write-manifest.js` records 0 bytes for a path that no longer exists at
  // HEAD, so a delete-only PR scores zero on the byte axis while still being
  // real review work — the rubric's own removed-behaviour angle. With equal
  // loads the packer's strict `<` scan also never left bin 0.
  const files = Array.from({ length: 40 }, (_, i) => f(`src/gone${i}.ts`, 0));
  const r = buildRoster({ files, models: { opus: "o", sonnet: "s", haiku: "h" } });
  assert.equal(r.k, 2);
  const bins = r.roles.filter((x) => x.kind === "coverage").map((x) => x.assigned_files.length);
  assert.deepEqual(bins, [20, 20]);
});

test("packClusters: a bin holding bytes is still reachable by zero-byte clusters", () => {
  // The file-count comparison used to be a tiebreak on EXACT byte equality, so a
  // bin holding any non-zero-byte cluster was never chosen again while a
  // zero-byte bin existed. Deleted paths are all zero bytes (no statSync entry
  // at HEAD), so one edit plus 25 deletions piled all 25 onto one reviewer.
  // The all-zero and all-equal cases were both pinned; the MIXED case — which is
  // where it breaks — was the test that was missing.
  const cs = [
    { paths: ["src/app.ts"], bytes: 4096 },
    { paths: Array.from({ length: 13 }, (_, i) => `d${i}`), bytes: 0 },
    { paths: Array.from({ length: 12 }, (_, i) => `e${i}`), bytes: 0 },
  ];
  const bins = packClusters(cs, 2).map((b) => b.length);
  assert.deepEqual(bins.slice().sort((a, b) => a - b), [13, 13]);
});

test("buildRoster: one edit plus 25 deletions does not pile onto one reviewer", () => {
  const files = [
    f("src/app.ts", 4096),
    ...Array.from({ length: 25 }, (_, i) => f(`src/legacy/f${i}.ts`, 0)),
  ];
  const r = buildRoster({ files, models: { opus: "o", sonnet: "s", haiku: "h" } });
  assert.equal(r.k, 2);
  assert.ok(
    r.max_bin_files <= FILES_PER_REVIEWER,
    `max_bin_files=${r.max_bin_files} exceeds the budget a valid packing could have met`,
  );
  const covered = r.roles.filter((x) => x.kind === "coverage").flatMap((x) => x.assigned_files);
  assert.deepEqual(covered.sort(), files.map((x) => x.path).sort());
});

test("packClusters: cost blends both axes, so neither can be starved", () => {
  // A bin loaded only on bytes and a bin loaded only on file count must both
  // look expensive. Otherwise whichever axis is zero reads as an empty bin.
  const cs = [
    { paths: ["heavy"], bytes: BUDGET_BYTES },
    { paths: Array.from({ length: FILES_PER_REVIEWER }, (_, i) => `many${i}`), bytes: 0 },
    { paths: ["next"], bytes: 1 },
  ];
  const bins = packClusters(cs, 2);
  // "next" must not join either full bin ahead of the other on a single axis;
  // with two bins it joins the cheaper blended one, and both stay non-empty.
  assert.equal(bins.length, 2);
  assert.equal(bins.flat().length, FILES_PER_REVIEWER + 2);
});

test("packClusters: a low-byte, near-full-count bin reads as expensive, not cheap", () => {
  // The test above holds under a bytes-only cost too — both models place
  // "next" so the aggregate counts come out the same, so it never actually
  // proved the blend is load-bearing. This one asserts the specific bin a
  // cluster joins, and picks a case where the two models disagree: a bin
  // near FILES_PER_REVIEWER but at 0 bytes looks CHEAP to a bytes-only
  // comparison (0 < 10000) and EXPENSIVE to the blend (19/20 ~= 0.95 versus
  // 10000/133120 ~= 0.075). A bytes-only packer would push the 19-file bin
  // over budget; the blend keeps it at 19 and grows the other bin instead.
  const cs = [
    { paths: ["a-heavy"], bytes: 10000 },
    { paths: Array.from({ length: 19 }, (_, i) => `many${i}`), bytes: 0 },
    { paths: ["c-small"], bytes: 1000 },
  ];
  const bins = packClusters(cs, 2);
  const withSmall = bins.find((b) => b.includes("c-small"));
  assert.deepEqual(withSmall.slice().sort(), ["a-heavy", "c-small"]);
  assert.equal(bins.find((b) => b !== withSmall).length, 19);
});

test("packClusters: equal byte loads break the tie on file count, not bin 0", () => {
  const cs = [
    { paths: ["a", "b"], bytes: 0 },
    { paths: ["c", "d"], bytes: 0 },
  ];
  const bins = packClusters(cs, 2);
  assert.equal(bins.length, 2, "all zero-byte clusters landed in one bin");
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

test("extractImports: dynamic import() counts too", () => {
  // A JS/TS spelling the regex silently sat outside, while its own comment
  // claimed to cover JS/TS. Costs a cut clustering edge, never a coverage gap —
  // but a documented scope should be true.
  const src = [
    `const a = await import("./a");`,
    `void import('../lib/b')`,
    `import.meta.url`,
  ].join("\n");
  const found = extractImports(src);
  assert.ok(found.includes("./a"), JSON.stringify(found));
  assert.ok(found.includes("../lib/b"), JSON.stringify(found));
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

test("buildRoster: every role names the artifact it writes", () => {
  // `roles[]` holds two different output contracts: `scorer` writes scores.json,
  // everything else writes findings/<role>.json. `kind: "scoring"` was the only
  // thing separating them and nothing said so, so the obvious PR-D/2 wiring —
  // roster: roles.map(r => r.role) — would hand aggregate() a scorer it expects
  // a findings file from, and get missing-role:scorer on every single run.
  const r = buildRoster({ files: [f("a.ts", 5)], models: { opus: "o", sonnet: "s", haiku: "h" } });
  const by = Object.fromEntries(r.roles.map((x) => [x.role, x]));
  assert.equal(by.scorer.artifact, ".ai-review/scores.json");
  assert.equal(by["reviewer-1"].artifact, ".ai-review/findings/reviewer-1.json");
  assert.equal(by.intent.artifact, ".ai-review/findings/intent.json");
  for (const role of r.roles) assert.equal(typeof role.artifact, "string", role.role);
});

test("buildRoster: the findings roster excludes the scorer", () => {
  // The list a consumer should pass to aggregate() as `roster`.
  const r = buildRoster({ files: [f("a.ts", 5)], models: { opus: "o", sonnet: "s", haiku: "h" } });
  assert.equal(r.findings_roles.includes("scorer"), false);
  assert.deepEqual(
    r.findings_roles,
    r.roles.filter((x) => x.kind !== "scoring").map((x) => x.role),
  );
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

test("buildRoster: a bin over the FILE budget is observable even when bytes are tiny", () => {
  // 60 tiny files in two directories: computeK gives 3 on the count axis,
  // splitOversized breaks each 30-file cluster into two atomic 15-file pieces
  // with no knowledge of k, and four equal pieces cannot balance into three
  // bins, giving [30,15,15] where [20,20,20] was reachable by splitting each
  // cluster into three 10-file pieces instead of two 15-file ones.
  //
  // NOT "unimprovable" — a real gap: splitOversized's per-cluster piece count
  // is derived from BUDGET_BYTES/FILES_PER_REVIEWER alone, with no knowledge of
  // K or of how many other oversized clusters exist, so it cannot know finer
  // pieces would let the packer balance globally. A deliberate choice to prefer
  // cluster locality (fewer, larger pieces) over chasing perfect balance is
  // defensible — clustering exists to preserve local comprehension for the
  // reviewer holding each piece — but it is a choice, not a limit, and this
  // test pins the current behaviour rather than claiming it is optimal.
  //
  // What was a genuine defect, and is fixed: nothing recorded the overflow.
  // k_capped is false and max_bin_bytes is far under budget precisely because
  // the files are small, so the byte-axis telemetry alone would have missed it.
  const files = [
    ...Array.from({ length: 30 }, (_, i) => f(`a/f${i}.ts`, 1000)),
    ...Array.from({ length: 30 }, (_, i) => f(`b/f${i}.ts`, 1000)),
  ];
  const r = buildRoster({ files, models: { opus: "o", sonnet: "s", haiku: "h" } });
  assert.equal(r.k_capped, false, "MAX_K did not bind here");
  assert.ok(r.max_bin_bytes < r.budget_bytes, "byte axis is not the limiter");
  assert.equal(r.max_bin_files, 30);
  assert.equal(r.budget_files, FILES_PER_REVIEWER);
});

test("buildRoster: k_capped means MAX_K actually bound, not merely that demand exceeded it", () => {
  // One indivisible 600 KB file: demand says 5 reviewers, but a file is atomic,
  // so the roster is 1. Reporting "MAX_K bound" for a one-reviewer roster sends
  // the next reader hunting the wrong limiter.
  const r = buildRoster({ files: [f("src/huge.ts", 600000)], models: { opus: "o", sonnet: "s", haiku: "h" } });
  assert.equal(r.k, 1);
  assert.equal(r.k_capped, false);
  assert.ok(r.max_bin_bytes > r.budget_bytes, "still over budget — just not because of the cap");
});

test("buildRoster: a binding MAX_K is stamped on the roster, not left implicit", () => {
  // splitOversized guarantees each PIECE fits the budget; packClusters has no
  // per-bin ceiling, so when MAX_K binds a bin legitimately exceeds it. The
  // tradeoff is deliberate — the gap was that nothing said so, and a consumer
  // reading assigned_files could not tell a within-budget bin from a 2x one.
  const files = Array.from({ length: 10 }, (_, i) => f(`src/f${i}.ts`, 100000));
  const r = buildRoster({ files, models: { opus: "o", sonnet: "s", haiku: "h" } });
  assert.equal(r.k, 4);
  assert.equal(r.k_capped, true);
  assert.equal(r.budget_bytes, BUDGET_BYTES);
  assert.ok(r.max_bin_bytes > BUDGET_BYTES, `max_bin_bytes=${r.max_bin_bytes}`);
});

test("buildRoster: an uncapped roster reports k_capped false and a bin within budget", () => {
  const files = [f("src/a.ts", 1000), f("lib/b.ts", 2000)];
  const r = buildRoster({ files, models: { opus: "o", sonnet: "s", haiku: "h" } });
  assert.equal(r.k_capped, false);
  assert.equal(r.max_bin_bytes, 3000);
});

test("buildRoster: the frame role's spelling matches aggregate.js's FRAME_ROLE", () => {
  // Independent literals — "intent" here, FRAME_ROLE in aggregate.js — with
  // nothing else relating them. A rename on either side desynchronises them
  // into a silent fail-open: hasFrame goes false, intent and checklist revert
  // to first-valid-wins across every role, and status stays "ok". This is the
  // tripwire that turns that rename into an immediate, loud test failure
  // instead of a fan-out-time surprise.
  const r = buildRoster({ files: [f("a.ts", 5)], models: { opus: "o", sonnet: "s", haiku: "h" } });
  assert.ok(r.findings_roles.includes(FRAME_ROLE), `findings_roles=${r.findings_roles}`);
  const frame = r.roles.find((x) => x.kind === "frame");
  assert.equal(frame.role, FRAME_ROLE);
});

test("buildRoster: an empty diff yields no coverage roles, and k says 0", () => {
  const r = buildRoster({ files: [], models: { opus: "o", sonnet: "s", haiku: "h" } });
  assert.equal(r.roles.filter((x) => x.kind === "coverage").length, 0);
  // `k` counts the coverage roles that exist, so it is 0 here — a value the
  // clamp(...,1,4) formula cannot produce. Pinned so the discrepancy is a
  // recorded decision rather than something a reader has to re-derive.
  assert.equal(r.k, 0);
});

test("buildRoster: output is JSON-serialisable and stable", () => {
  const args = { files: [f("src/a.ts", 10), f("src/b.ts", 20)], models: { opus: "o", sonnet: "s", haiku: "h" } };
  assert.deepEqual(
    JSON.parse(JSON.stringify(buildRoster(args))),
    JSON.parse(JSON.stringify(buildRoster(args))),
  );
});
