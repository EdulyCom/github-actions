"use strict";

// Deterministic roster for the parallel review (spec §4 and §5).
//
// This module answers one question — *who reads what* — before any model turn
// runs. Nothing here is behavioural yet: the review stage is still serial, and
// the roster it emits is written to `.ai-review/assignments.json`; nothing
// reads it yet. Fan-out consumes it unchanged when it lands.
//
// Two properties are load-bearing and are the reason this is a tested module
// rather than a jq pipeline in the composite action:
//
//   1. **A partition, not a heuristic.** Coverage roles must be pairwise
//      disjoint and their union must equal `changed_files` exactly. A file
//      silently missing from every bin is a file nobody reads — and the review
//      would still report `verdict: pass`, because nothing downstream can tell
//      "reviewed and clean" from "never opened". `assertPartition` hard-fails
//      instead.
//   2. **No partition can split a file.** Roles hold whole paths. There is no
//      byte-range or line-range field anywhere in the schema, so splitting one
//      file's contents across two reviewers is unrepresentable rather than
//      merely discouraged. That is what makes the owner's hardest constraint —
//      "must read all" — survive parallelism.
//
// Pure: no I/O, no git, no process.env. The caller supplies paths with their
// full-file byte size at HEAD (`write-manifest.js` uses `fs.statSync` — the
// working tree is already checked out, so a stat is both cheaper and exactly
// the byte count a reviewer reading the file will face) and, optionally,
// import edges from a grep pass.

const { TEST_DIR_SEGMENTS } = require("./prep.js");

/**
 * Per-reviewer read budget. ~35K tokens of file content, leaving a Sonnet
 * reviewer room for surrounding-context reads and its own reasoning (spec §5).
 */
const BUDGET_BYTES = 130 * 1024;

/**
 * Fan out past this many changed files even under the byte budget: per-file
 * attention costs something independent of total bytes (spec §5).
 */
const FILES_PER_REVIEWER = 20;

/**
 * Cap is 4, not 8. K concurrent Sonnet reviewers plus a wave of Haiku scorers
 * share one gateway and one key; 8 was set before that exposure was considered.
 */
const MAX_K = 4;

/**
 * The one cost model both `splitOversized` and `packClusters` place against:
 * each axis as a fraction of its own budget, summed. Whichever axis reads zero
 * would otherwise starve the other — a piece or bin holding any bytes loses
 * every comparison to an all-zero one regardless of how full it already is on
 * the other axis, which is exactly the shape deleted files (0 bytes) and tiny
 * files (many, low bytes) both take.
 *
 * Defined once and reused at all three call sites deliberately, not as
 * tidiness: this formula has already diverged twice in this module's history
 * — `packClusters` was fixed for it before `splitOversized` was, and each time
 * the divergence was silent (a legal-looking, unevenly-loaded roster with
 * nothing in the telemetry to flag it, since the emitted numbers can land
 * exactly on budget). A single definition makes the next re-weighting apply
 * everywhere or fail to compile everywhere; it cannot apply in two places and
 * miss a third.
 */
const blendedCost = (bytes, count, cap, capFiles) =>
  (Number.isFinite(bytes) ? bytes : 0) / cap + count / capFiles;

/**
 * Test-file markers, used to find a test's *partner source file* — a different
 * job from `prep.js`'s `classifyPaths`, which only needs a yes/no for the
 * `no_tests_for_changed_logic` penalty. The two stay separate deliberately: one
 * regex serving both would have to be loose enough to classify and precise
 * enough to strip, and would drift toward failing at both.
 *
 * The directory alternation IS shared, imported rather than copied — the two
 * copies had already diverged once, and a silent divergence here costs a weaker
 * cluster with nothing to signal it.
 */
const TEST_DIR_RE = new RegExp(`(^|/)(${TEST_DIR_SEGMENTS})(/|$)`);
const TEST_SUFFIX_RE = /[.\-_](?:test|spec)$/i;
const TEST_PREFIX_RE = /^test[_-]/i;

const dirName = (p) => {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
};

/** Number of leading directory segments two paths share. */
function sharedDirDepth(a, b) {
  const x = dirName(a).split("/");
  const y = dirName(b).split("/");
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n] && x[n] !== "") n += 1;
  return n;
}

const baseName = (p) => {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
};

/** `src/auth.test.ts` -> `{stem: "auth", ext: "ts", isTest: true}` */
function nameParts(path) {
  const base = baseName(path);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  let stem = dot > 0 ? base.slice(0, dot) : base;

  let marked = false;
  if (TEST_SUFFIX_RE.test(stem)) {
    stem = stem.replace(TEST_SUFFIX_RE, "");
    marked = true;
  } else if (TEST_PREFIX_RE.test(stem)) {
    stem = stem.replace(TEST_PREFIX_RE, "");
    marked = true;
  }

  return { stem, ext, isTest: marked || TEST_DIR_RE.test(path) };
}

/**
 * K is a read budget, not a size cap.
 *
 * Fan-out activates only when the work exceeds what one reviewer can hold with
 * full comprehension. Below that, one reviewer *is* the optimum — not a
 * degraded fallback — and fan-out would add coordination cost for nothing.
 * K=1 therefore collapses the roster; it never branches the pipeline.
 *
 * Budget and maxFiles are parameters, matching `splitOversized` and
 * `packClusters` — both default to the module constants, but a caller who
 * tunes those two and calls this with the module defaults would size the
 * roster against a budget the rest of the pipeline no longer honours, with
 * no error and no log line.
 *
 * @param {{totalBytes: number, fileCount: number, budget?: number, maxFiles?: number}} args
 * @returns {number} integer in [1, MAX_K]
 */
function computeK({ totalBytes, fileCount, budget, maxFiles } = {}) {
  const bytes = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
  const count = Number.isFinite(fileCount) && fileCount > 0 ? fileCount : 0;
  const cap = Number.isFinite(budget) && budget > 0 ? budget : BUDGET_BYTES;
  const capFiles =
    Number.isFinite(maxFiles) && maxFiles >= 1 ? Math.floor(maxFiles) : FILES_PER_REVIEWER;

  const byBytes = Math.ceil(bytes / cap);
  const byCount = Math.ceil(count / capFiles);

  return Math.min(MAX_K, Math.max(1, byBytes, byCount));
}

/** Minimal union-find over array indices. */
function makeUnionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) {
      const next = parent[i];
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  return { find, union };
}

/**
 * Group changed files into clusters of related files (spec §4 step 2-3).
 *
 * Edges, all drawn among *changed files only*:
 *   - same immediate directory;
 *   - test <-> source naming pairs (`foo.test.ts` <-> `foo.ts`), which is the
 *     one edge worth crossing a directory boundary for.
 *   - caller-supplied import/require pairs.
 *
 * The naming edge requires one side to actually be a test. Matching on
 * basename alone would join every `index.ts` in the repo into a single cluster
 * and leave packing nothing to balance — the failure is silent, since the
 * result is still a valid partition, just a useless one. For the same reason a
 * test pairs with its *nearest* same-named source rather than the first one
 * seen: with `pkg-a/foo.ts` and `pkg-b/foo.ts` both in the diff, first-writer
 * -wins would wire `pkg-b/foo.test.ts` across the package boundary and drag
 * both packages into one cluster.
 *
 * Clusters, not files, are the packing unit: keeping related files with one
 * reviewer is what makes each reviewer's local comprehension possible. It does
 * not eliminate cut edges — that is the tracer's job, and why the tracer exists.
 *
 * @param {Array<{path: string, bytes: number}>} files
 * @param {Array<[string, string]>} [extraEdges] import/require pairs; entries
 *   naming a path outside `files` are ignored rather than fabricated.
 * @returns {Array<{paths: string[], bytes: number}>}
 */
function clusterFiles(files, extraEdges) {
  const list = (Array.isArray(files) ? files : [])
    .map((f) => ({
      path: String(f?.path ?? ""),
      bytes: Number.isFinite(Number(f?.bytes)) ? Number(f.bytes) : 0,
    }))
    .filter((f) => f.path !== "");

  if (list.length === 0) return [];

  const index = new Map(list.map((f, i) => [f.path, i]));
  const uf = makeUnionFind(list.length);

  const byDir = new Map();
  const byPair = new Map();

  list.forEach((f, i) => {
    const dir = dirName(f.path);
    if (byDir.has(dir)) uf.union(byDir.get(dir), i);
    else byDir.set(dir, i);

    const { stem, ext, isTest } = nameParts(f.path);
    if (stem === "") return;
    const key = `${stem}\u0000${ext}`;
    const slot = byPair.get(key) || { tests: [], sources: [] };
    (isTest ? slot.tests : slot.sources).push(i);
    byPair.set(key, slot);
  });

  for (const slot of byPair.values()) {
    if (slot.tests.length === 0 || slot.sources.length === 0) continue;
    for (const t of slot.tests) {
      let best = slot.sources[0];
      let bestDepth = -1;
      for (const s of slot.sources) {
        const depth = sharedDirDepth(list[t].path, list[s].path);
        // Strict `>` keeps the first source on a tie, so the roster is stable
        // across runs on the same diff.
        if (depth > bestDepth) {
          bestDepth = depth;
          best = s;
        }
      }
      uf.union(t, best);
    }
  }

  for (const edge of Array.isArray(extraEdges) ? extraEdges : []) {
    const a = index.get(String(edge?.[0] ?? ""));
    const b = index.get(String(edge?.[1] ?? ""));
    if (a !== undefined && b !== undefined) uf.union(a, b);
  }

  const groups = new Map();
  list.forEach((f, i) => {
    const root = uf.find(i);
    const g = groups.get(root) || { paths: [], bytes: 0, sizes: Object.create(null) };
    g.paths.push(f.path);
    g.bytes += f.bytes;
    g.sizes[f.path] = f.bytes;
    groups.set(root, g);
  });

  // `sizes` rides along so splitOversized can chunk at file boundaries without
  // re-deriving what this pass already knows.
  return [...groups.values()]
    .map((g) => ({ paths: g.paths.slice().sort(), bytes: g.bytes, sizes: g.sizes }))
    .sort((a, b) => (a.paths[0] < b.paths[0] ? -1 : a.paths[0] > b.paths[0] ? 1 : 0));
}

/**
 * Split any cluster that alone exceeds a per-reviewer budget (spec §4 step 4).
 *
 * Without this the most ordinary diff shape there is — every changed file in
 * one directory — unions into a single cluster, `packClusters` has exactly one
 * thing to place, and K collapses to 1 no matter what `computeK` returned. The
 * partition is still valid, so `assertPartition` says nothing, and one reviewer
 * silently holds the whole diff while the emitted `k` claims otherwise.
 *
 * **Both** of `computeK`'s axes are enforced here, because a guard on bytes
 * alone leaves `FILES_PER_REVIEWER` unable to reach the emitted roster at all:
 * 25 files of 2 KB under `src/` sail under the byte cap, clamp the packer to one
 * bin, and silently contradict the count term that spec §5 put there on purpose.
 * The same hole swallows a delete-only diff, where every path is 0 bytes at HEAD
 * yet reviewing removed behaviour is real work.
 *
 * Splitting is **at file boundaries only** — a file is atomic, so a single file
 * larger than the byte budget is left whole rather than truncated. That is the
 * "must read all" constraint winning over the budget, which is the correct
 * direction for it to lose.
 *
 * @returns {{clusters: Array<{paths, bytes, sizes}>, splitGroups: string[][]}}
 *   `splitGroups` lists the full membership of each cluster that had to be
 *   broken up. It is emitted to the roster because those internal edges no
 *   longer live with one reviewer, and the tracer owns them instead.
 */
function splitOversized(clusters, budget, maxFiles) {
  const cap = Number.isFinite(budget) && budget > 0 ? budget : BUDGET_BYTES;
  const capFiles =
    Number.isFinite(maxFiles) && maxFiles >= 1 ? Math.floor(maxFiles) : FILES_PER_REVIEWER;
  const out = [];
  const splitGroups = [];

  for (const c of Array.isArray(clusters) ? clusters : []) {
    const paths = Array.isArray(c?.paths) ? c.paths : [];
    const bytes = Number.isFinite(c?.bytes) ? c.bytes : 0;
    const sizes = c?.sizes;

    if (paths.length < 2 || (bytes <= cap && paths.length <= capFiles) || !sizes) {
      out.push(c);
      continue;
    }

    const sizeOf = (p) => {
      const n = Number(sizes[p]);
      return Number.isFinite(n) ? n : 0;
    };

    // Largest file first, so a big one opens its own piece instead of landing
    // last and stranding a piece it cannot fit into.
    const ordered = paths
      .slice()
      .sort((a, b) => sizeOf(b) - sizeOf(a) || (a < b ? -1 : a > b ? 1 : 0));

    // Open the minimum number of pieces the budgets demand up front, then fill
    // them least-loaded-first. Filling greedily to the cap instead would give 25
    // small files a 20/5 split: legal, but reviewer-1 then does 4x the work, and
    // parallel wall-clock is max() not sum(), so most of the win is thrown away.
    const pieceCount = Math.min(
      paths.length,
      Math.max(2, Math.ceil(bytes / cap), Math.ceil(paths.length / capFiles)),
    );
    const pieces = Array.from({ length: pieceCount }, () => ({
      paths: [],
      bytes: 0,
      sizes: Object.create(null),
    }));

    // A cluster mixing one byte-carrying file with more than 2x capFiles
    // zero-byte ones — one edit plus 44 deletions — used to put [5, 20, 20]
    // where blendedCost gives [15, 15, 15], reachable and previously missed.
    const pieceCost = (piece) => blendedCost(piece.bytes, piece.paths.length, cap, capFiles);

    for (const p of ordered) {
      const size = sizeOf(p);
      let best = null;
      for (const piece of pieces) {
        // A file larger than the whole budget fits nowhere and opens its own
        // piece below — it is never split, and never crowds another file.
        if (piece.bytes + size > cap || piece.paths.length >= capFiles) continue;
        if (best === null || pieceCost(piece) < pieceCost(best)) {
          best = piece;
        }
      }
      if (best === null) {
        best = { paths: [], bytes: 0, sizes: Object.create(null) };
        pieces.push(best);
      }
      best.paths.push(p);
      best.bytes += size;
      best.sizes[p] = size;
    }

    const filled = pieces.filter((piece) => piece.paths.length > 0);
    if (filled.length <= 1) {
      out.push(c);
      continue;
    }
    for (const piece of filled) {
      piece.paths.sort();
      out.push(piece);
    }
    splitGroups.push(paths.slice().sort());
  }

  return { clusters: out, splitGroups };
}

/**
 * Pack clusters into at most K bins, largest first.
 *
 * The spec says "first-fit-decreasing". With a fixed K and no per-bin capacity
 * there is no bin to *fail* to fit, so literal first-fit would pile everything
 * into bin 0; the correct reading at fixed K is decreasing-size greedy into the
 * least-loaded bin (LPT).
 *
 * "Least loaded" is a BLENDED cost — each axis as a fraction of its own budget,
 * summed — not bytes with file count as a tiebreak. Bytes-first with a tiebreak
 * on exact equality means a bin holding any non-zero-byte cluster is never
 * chosen again while a zero-byte bin exists, and deleted paths are all zero
 * bytes (they have no size at HEAD). One 4 KB edit plus 25 deletions therefore
 * put 1 file on the first reviewer and 25 on the second, while `{edit + 12}` and
 * `{13}` sat inside both budgets and was never reached. Whichever axis reads
 * zero would starve the other; blending is what makes both count.
 *
 * It is also the honest cost model: reading N files of B total bytes costs
 * per-file attention *and* bytes, so a sum of the two normalised loads tracks
 * what a reviewer actually spends. Ties break on bin index, and cluster order
 * breaks on first path, so the roster is byte-identical across runs on the same
 * diff.
 *
 * Empty bins are dropped: a reviewer with nothing to read is a model stage that
 * costs wall-clock and can only report "nothing to review".
 *
 * Budgets are parameters, matching `splitOversized`: both are exported, and a
 * caller who tuned the split down and then packed against hardcoded constants
 * would get pieces sized for their budget and a balance scored against someone
 * else's, with no error and no log line.
 *
 * @returns {string[][]} one path list per bin
 */
function packClusters(clusters, k, budget, maxFiles) {
  const cap = Number.isFinite(budget) && budget > 0 ? budget : BUDGET_BYTES;
  const capFiles =
    Number.isFinite(maxFiles) && maxFiles >= 1 ? Math.floor(maxFiles) : FILES_PER_REVIEWER;
  const list = (Array.isArray(clusters) ? clusters : []).filter(
    (c) => Array.isArray(c?.paths) && c.paths.length > 0,
  );
  if (list.length === 0) return [];

  const bins = Math.max(1, Math.min(Number.isFinite(k) ? Math.floor(k) : 1, list.length));

  // Ordered by the SAME blended cost used to place, not by bytes. Decreasing
  // greedy only bounds imbalance when the two agree: with a bytes-only sort a
  // large zero-byte cluster (20 deletions) sorts last and lands on a bin that is
  // already occupied, giving [1, 21] when [20, 2] was legal on both axes and
  // never considered.
  const clusterCost = (c) => blendedCost(c.bytes, c.paths.length, cap, capFiles);
  const sorted = list.slice().sort((a, b) => {
    const d = clusterCost(b) - clusterCost(a);
    if (d !== 0) return d;
    return a.paths[0] < b.paths[0] ? -1 : a.paths[0] > b.paths[0] ? 1 : 0;
  });

  const loads = new Array(bins).fill(0);
  const out = Array.from({ length: bins }, () => []);
  const cost = (i) => blendedCost(loads[i], out[i].length, cap, capFiles);

  for (const cluster of sorted) {
    let target = 0;
    for (let i = 1; i < bins; i += 1) {
      if (cost(i) < cost(target)) target = i;
    }
    out[target].push(...cluster.paths);
    loads[target] += Number.isFinite(cluster.bytes) ? cluster.bytes : 0;
  }

  return out.filter((b) => b.length > 0);
}

/**
 * Import/require specifiers appearing in a source file.
 *
 * Regex-grade on purpose, exactly like `prep.js`'s symbol extraction: this
 * feeds a *clustering hint*, and over-collection costs one extra union while a
 * miss costs a cut edge. A commented-out import producing a spurious edge is
 * the cheapest possible error here.
 *
 * JS/TS spellings only — static `import`/`export … from`, dynamic `import(…)`,
 * and `require(…)`. Other ecosystems fall back to the directory and test-pair
 * edges, which is a weaker cluster, not a coverage gap — every changed file is
 * still assigned to exactly one reviewer either way.
 */
const IMPORT_RE =
  /(?:^|[^\w$])(?:import|export)\s+(?:[^'"()]*?\sfrom\s+)?['"]([^'"]+)['"]|(?:^|[^\w$])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function extractImports(text) {
  if (typeof text !== "string") return [];
  const out = [];
  const seen = new Set();
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(text)) !== null) {
    const spec = m[1] ?? m[2];
    if (spec && !seen.has(spec)) {
      seen.add(spec);
      out.push(spec);
    }
  }
  return out;
}

/** Resolve `a/b/../c` -> `a/c` without touching the filesystem. */
function normalizeParts(parts) {
  const out = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

const MODULE_EXTS = [
  "", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".d.ts", ".vue", ".svelte",
];

/**
 * Turn per-file import specifiers into adjacency edges among changed files.
 *
 * Only relative specifiers resolve. A bare specifier is a package, and a
 * relative one that lands outside the diff is the tracer's problem, not the
 * partition's — edges are drawn among changed files only (spec §4 step 2).
 *
 * @param {Record<string, string[]>} specifiersByPath
 * @param {string[]} changedFiles
 * @returns {Array<[string, string]>}
 */
function resolveImportEdges(specifiersByPath, changedFiles) {
  const changed = new Set((Array.isArray(changedFiles) ? changedFiles : []).map(String));
  const edges = [];
  const seen = new Set();

  const specs = specifiersByPath && typeof specifiersByPath === "object" ? specifiersByPath : {};
  for (const [importer, list] of Object.entries(specs)) {
    if (!changed.has(importer)) continue;
    const dir = dirName(importer);

    for (const raw of Array.isArray(list) ? list : []) {
      const spec = String(raw ?? "");
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue;

      const base = normalizeParts(`${dir}/${spec}`.split("/"));
      let target = null;
      for (const ext of MODULE_EXTS) {
        if (changed.has(base + ext)) {
          target = base + ext;
          break;
        }
        if (ext !== "" && changed.has(`${base}/index${ext}`)) {
          target = `${base}/index${ext}`;
          break;
        }
      }

      if (target === null || target === importer) continue;
      const key = importer < target ? `${importer}\u0000${target}` : `${target}\u0000${importer}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([importer, target]);
    }
  }

  return edges;
}

/**
 * Hard-fail unless the coverage bins are an exact partition of `changedFiles`
 * (spec §4, §6 step 2).
 *
 * Every failure mode here is silent downstream: an unassigned file reads as
 * "reviewed and clean", a duplicated file wastes a reviewer and can produce two
 * ids for one defect, and a stray path means the bins were built against a
 * different diff than the one being gated. None of the three is visible in a
 * review body, so the check has to be here.
 *
 * @throws {Error} on any violation
 */
function assertPartition(bins, changedFiles) {
  const expected = new Set((Array.isArray(changedFiles) ? changedFiles : []).map(String));
  const seen = new Set();

  for (const bin of Array.isArray(bins) ? bins : []) {
    for (const raw of Array.isArray(bin) ? bin : []) {
      const path = String(raw);
      if (seen.has(path)) {
        throw new Error(`roster: ${path} assigned twice — coverage bins must be disjoint`);
      }
      if (!expected.has(path)) {
        throw new Error(`roster: ${path} is not in changed_files`);
      }
      seen.add(path);
    }
  }

  const missing = [...expected].filter((p) => !seen.has(p));
  if (missing.length > 0) {
    throw new Error(
      `roster: ${missing.length} changed file(s) unassigned — ${missing.slice(0, 5).join(", ")}`,
    );
  }
}

/**
 * Non-coverage roles, in emission order.
 *
 * Effort is per role, not per stage. Reviewers, tracer and intent run `high`
 * because they carry the judgment; effort multiplies turns and wall-clock is
 * linear in turns (~24s each), so `xhigh`/`max` buys overthinking, not recall.
 *
 * The Haiku roles carry **no `effort` key at all** — Haiku 4.5 rejects the
 * parameter at the API, and whether the CLI strips it client-side for
 * unsupported models is unverified. An omitted key cannot be rejected.
 */
const SUPPORT_ROLES = [
  { role: "tracer", kind: "coherence", tier: "sonnet", effort: "high" },
  { role: "intent", kind: "frame", tier: "opus", effort: "high" },
  { role: "history", kind: "perspective", tier: "haiku" },
  { role: "scorer", kind: "scoring", tier: "haiku" },
];

/**
 * `roles[]` carries TWO output contracts, and that has to be stated in the data
 * rather than inferred from a `kind` string. Every role but `scorer` writes
 * `findings/<role>.json`; `scorer` writes `scores.json`. A consumer wiring the
 * roster the obvious way — `roster: roles.map(r => r.role)` — would hand
 * `aggregate()` a role it then demands a findings file from, and get
 * `missing-role:scorer` on every single run. Each role names its own artifact,
 * and `findings_roles` is the list that actually belongs in `roster`.
 */
const artifactFor = (role, kind) =>
  kind === "scoring" ? ".ai-review/scores.json" : `.ai-review/findings/${role}.json`;

/**
 * Assemble `.ai-review/assignments.json` (schema 1, frozen by spec §6).
 *
 * @param {object} args
 * @param {Array<{path: string, bytes: number}>} args.files  changed paths with
 *   full-file byte size at HEAD
 * @param {{opus: string, sonnet: string, haiku: string}} args.models  resolved
 *   model ids, so a consumer override flows through instead of being hardcoded
 * @param {Array<[string, string]>} [args.importEdges]
 * @param {Array<object>} [args.symbolManifest]
 * @param {boolean} [args.hasTestChange]
 * @param {boolean} [args.hasLogicChange]
 * @param {boolean} [args.modifiesReviewerGuidance]
 */
function buildRoster({
  files,
  models,
  importEdges,
  symbolManifest,
  hasTestChange,
  hasLogicChange,
  modifiesReviewerGuidance,
} = {}) {
  const list = (Array.isArray(files) ? files : []).filter((f) => f && f.path);
  const changed = list.map((f) => String(f.path));
  const tiers = {
    opus: models?.opus ?? null,
    sonnet: models?.sonnet ?? null,
    haiku: models?.haiku ?? null,
  };

  const totalBytes = list.reduce((sum, f) => {
    const n = Number(f.bytes);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);

  const k = computeK({
    totalBytes,
    fileCount: changed.length,
    budget: BUDGET_BYTES,
    maxFiles: FILES_PER_REVIEWER,
  });
  const split = splitOversized(clusterFiles(list, importEdges), BUDGET_BYTES, FILES_PER_REVIEWER);
  const bins = packClusters(split.clusters, k, BUDGET_BYTES, FILES_PER_REVIEWER);
  assertPartition(bins, changed);

  // `splitOversized` guarantees each *piece* fits both budgets; `packClusters`
  // has no per-bin ceiling, so a bin can legitimately exceed one. THREE distinct
  // limiters produce that, but the stamps below distinguish only TWO of them —
  // said plainly rather than implying finer resolution than they have:
  //
  //   1. MAX_K binds. Ten 100 KB files -> K=4 and ~250 KB per reviewer. Rate-limit
  //      exposure, deliberate; `k_capped` says so, and is the one limiter this
  //      fully isolates.
  //   2. A file is indivisible. One 600 KB file is one reviewer at 600 KB, and no
  //      value of K changes that. `k_capped` must be FALSE here — demand exceeded
  //      MAX_K, but the cap bound nothing, and saying otherwise sends the next
  //      reader hunting the wrong limiter.
  //   3. Atomic pieces cannot balance. On the FILE-COUNT axis this is isolated —
  //      60 tiny files in two directories give bins of [30,15,15] with
  //      `max_bin_files` over budget and `max_bin_bytes` untouched, so a
  //      count-only overflow reads unambiguously. On the BYTE axis it does not:
  //      several atomic clusters too large to co-locate present identically to
  //      limiter 2 (`k_capped: false`, `max_bin_bytes` over budget) — this
  //      module cannot tell "one big file" from "several medium ones that
  //      couldn't be packed together" without a field neither telemetry
  //      consumer has needed yet.
  const byPath = new Map(list.map((f) => [String(f.path), Number(f.bytes) || 0]));
  const binBytes = bins.map((paths) => paths.reduce((sum, p) => sum + (byPath.get(p) || 0), 0));
  const uncappedK = Math.max(
    1,
    Math.ceil(totalBytes / BUDGET_BYTES),
    Math.ceil(changed.length / FILES_PER_REVIEWER),
  );

  // Defensive, not cosmetic: a consumer is free to point `sonnet-model` at a
  // Haiku id, and the effort key would then be rejected by the API on a role
  // the table thinks is safe. Resolve effort against the model that actually
  // runs, never against the tier name.
  const role = (spec, assigned) => {
    const model = tiers[spec.tier];
    const out = {
      role: spec.role,
      kind: spec.kind,
      model,
      artifact: artifactFor(spec.role, spec.kind),
      assigned_files: assigned,
    };
    // A literal substring match, not full gateway-alias resolution: it catches
    // a consumer override that names Haiku directly (e.g. `sonnet-model:
    // claude-haiku-4-5`), but not a gateway alias that ROUTES to Haiku under an
    // unrelated string (e.g. `gw-fast-1`) — `anthropic-base-url`'s own
    // description documents that such aliases exist. No live effect either way:
    // nothing consumes the roster yet, so nothing reads `effort`.
    if (spec.effort && !/haiku/i.test(String(model ?? ""))) out.effort = spec.effort;
    return out;
  };

  const roles = bins.map((paths, i) =>
    role({ role: `reviewer-${i + 1}`, kind: "coverage", tier: "sonnet", effort: "high" }, paths),
  );
  for (const spec of SUPPORT_ROLES) roles.push(role(spec, []));

  return {
    schema: 1,
    k: bins.length,
    roles,
    // The list to pass as aggregate()'s `roster`. Precomputed rather than left as
    // a filter for the caller to remember, because forgetting it fails every run.
    findings_roles: roles.filter((r) => r.kind !== "scoring").map((r) => r.role),
    changed_files: changed,
    // Clusters that had to be broken across reviewers: their internal edges are
    // the tracer's responsibility now, since no single reviewer holds them.
    split_clusters: split.splitGroups,
    budget_bytes: BUDGET_BYTES,
    max_bin_bytes: binBytes.length > 0 ? Math.max(...binBytes) : 0,
    budget_files: FILES_PER_REVIEWER,
    max_bin_files: bins.length > 0 ? Math.max(...bins.map((b) => b.length)) : 0,
    // True only when raising MAX_K could actually have changed this roster.
    // `bins.length >= MAX_K` separates limiter 1 from limiter 2 but not from a
    // third binder: with 4 pieces and MAX_K 4, `min(k, pieces)` is 4 either way,
    // so a higher cap yields the identical roster and reporting "MAX_K bound"
    // sends whoever reads the telemetry to raise a cap that is not the
    // constraint. There must be more pieces than the cap for it to bind.
    k_capped:
      uncappedK > MAX_K && bins.length >= MAX_K && split.clusters.length > MAX_K,
    symbol_manifest: Array.isArray(symbolManifest) ? symbolManifest : [],
    has_test_change: hasTestChange === true,
    has_logic_change: hasLogicChange === true,
    modifies_reviewer_guidance: modifiesReviewerGuidance === true,
  };
}

module.exports = {
  BUDGET_BYTES,
  FILES_PER_REVIEWER,
  MAX_K,
  computeK,
  clusterFiles,
  packClusters,
  splitOversized,
  extractImports,
  resolveImportEdges,
  assertPartition,
  buildRoster,
};
