"use strict";

// Deterministic roster for the parallel review (spec §4 and §5).
//
// This module answers one question — *who reads what* — before any model turn
// runs. Nothing here is behavioural yet: the review stage is still serial, and
// the roster it emits is written to `.ai-review/assignments.json` and read only
// by the shadow aggregation. Fan-out consumes it unchanged.
//
// Two properties are load-bearing and are the reason this is a tested module
// rather than a jq pipeline in the composite action:
//
//   1. **A partition, not a heuristic.** Coverage roles must be pairwise
//      disjoint and their union must equal `changed_files` exactly. A file
//      silently missing from every bin is a file nobody reads — and the review
//      would still report `verdict: pass`, because nothing downstream can tell
//      "reviewed and clean" from "never opened". `assertPartition` hard-fails
//      instead. `aggregate.js` records this assertion as its one unimplemented
//      spec step (vacuous at roster size 1); this is where it lives.
//   2. **No partition can split a file.** Roles hold whole paths. There is no
//      byte-range or line-range field anywhere in the schema, so splitting one
//      file's contents across two reviewers is unrepresentable rather than
//      merely discouraged. That is what makes the owner's hardest constraint —
//      "must read all" — survive parallelism.
//
// Pure: no I/O, no git, no process.env. The caller supplies paths with their
// full-file byte size at HEAD (`git cat-file -s`) and, optionally, import edges
// from a grep pass.

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
 * Test-file markers, used to find a test's *partner source file* — a different
 * job from `prep.js`'s `classifyPaths`, which only needs a yes/no for the
 * `no_tests_for_changed_logic` penalty. Kept separate deliberately: one regex
 * serving both would have to be loose enough to classify and precise enough to
 * strip, and would drift toward failing at both.
 */
const TEST_DIR_RE = /(^|\/)(tests?|spec|__tests__|__mocks__)(\/|$)/;
const TEST_SUFFIX_RE = /[.\-_](?:test|spec)$/i;
const TEST_PREFIX_RE = /^test[_-]/i;

const dirName = (p) => {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
};

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
 * @param {{totalBytes: number, fileCount: number}} args
 * @returns {number} integer in [1, MAX_K]
 */
function computeK({ totalBytes, fileCount } = {}) {
  const bytes = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
  const count = Number.isFinite(fileCount) && fileCount > 0 ? fileCount : 0;

  const byBytes = Math.ceil(bytes / BUDGET_BYTES);
  const byCount = Math.ceil(count / FILES_PER_REVIEWER);

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
 * result is still a valid partition, just a useless one.
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
    const slot = byPair.get(key) || { test: null, source: null };
    if (isTest) {
      if (slot.test === null) slot.test = i;
    } else if (slot.source === null) {
      slot.source = i;
    }
    byPair.set(key, slot);
  });

  for (const slot of byPair.values()) {
    if (slot.test !== null && slot.source !== null) uf.union(slot.test, slot.source);
  }

  for (const edge of Array.isArray(extraEdges) ? extraEdges : []) {
    const a = index.get(String(edge?.[0] ?? ""));
    const b = index.get(String(edge?.[1] ?? ""));
    if (a !== undefined && b !== undefined) uf.union(a, b);
  }

  const groups = new Map();
  list.forEach((f, i) => {
    const root = uf.find(i);
    const g = groups.get(root) || { paths: [], bytes: 0 };
    g.paths.push(f.path);
    g.bytes += f.bytes;
    groups.set(root, g);
  });

  return [...groups.values()]
    .map((g) => ({ paths: g.paths.slice().sort(), bytes: g.bytes }))
    .sort((a, b) => (a.paths[0] < b.paths[0] ? -1 : a.paths[0] > b.paths[0] ? 1 : 0));
}

/**
 * Pack clusters into at most K bins, largest first.
 *
 * The spec says "first-fit-decreasing". With a fixed K and no per-bin capacity
 * there is no bin to *fail* to fit, so literal first-fit would pile everything
 * into bin 0; the correct reading at fixed K is decreasing-size greedy into the
 * least-loaded bin (LPT). Ties break on bin index, then on first path, so the
 * roster is byte-identical across runs on the same diff.
 *
 * Empty bins are dropped: a reviewer with nothing to read is a model stage that
 * costs wall-clock and can only report "nothing to review".
 *
 * @returns {string[][]} one path list per bin
 */
function packClusters(clusters, k) {
  const list = (Array.isArray(clusters) ? clusters : []).filter(
    (c) => Array.isArray(c?.paths) && c.paths.length > 0,
  );
  if (list.length === 0) return [];

  const bins = Math.max(1, Math.min(Number.isFinite(k) ? Math.floor(k) : 1, list.length));

  const sorted = list.slice().sort((a, b) => {
    if (b.bytes !== a.bytes) return b.bytes - a.bytes;
    return a.paths[0] < b.paths[0] ? -1 : a.paths[0] > b.paths[0] ? 1 : 0;
  });

  const loads = new Array(bins).fill(0);
  const out = Array.from({ length: bins }, () => []);

  for (const cluster of sorted) {
    let target = 0;
    for (let i = 1; i < bins; i += 1) {
      if (loads[i] < loads[target]) target = i;
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
 * JS/TS spellings only. Other ecosystems fall back to the directory and
 * test-pair edges, which is a weaker cluster, not a coverage gap — every
 * changed file is still assigned to exactly one reviewer either way.
 */
const IMPORT_RE =
  /(?:^|[^\w$])(?:import|export)\s+(?:[^'"()]*?\sfrom\s+)?['"]([^'"]+)['"]|(?:^|[^\w$])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

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

const MODULE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".d.ts", ".vue", ".svelte"];

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

  const k = computeK({ totalBytes, fileCount: changed.length });
  const bins = packClusters(clusterFiles(list, importEdges), k);
  assertPartition(bins, changed);

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
      assigned_files: assigned,
    };
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
    changed_files: changed,
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
  extractImports,
  resolveImportEdges,
  assertPartition,
  buildRoster,
};
