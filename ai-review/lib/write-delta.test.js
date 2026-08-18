"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  filterBotReviews,
  priorHeadIsAncestorOf,
  writeDeltaArtifacts,
  main,
} = require("./write-delta.js");
const { formatReviewMeta } = require("./delta.js");

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PRIOR = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BASE = "cccccccccccccccccccccccccccccccccccccccc";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Linear history: orphan → baseCommit → priorCommit → headCommit.
 * Files: base.txt (base), prior.txt (prior), head.txt (head only).
 */
function makeLinearRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delta-git-"));
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "delta-test@example.com"]);
  git(dir, ["config", "user.name", "delta-test"]);
  // Default branch name varies by git version; pin it.
  git(dir, ["checkout", "-b", "main"]);

  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  git(dir, ["add", "base.txt"]);
  git(dir, ["commit", "-m", "base"]);
  const baseSha = git(dir, ["rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(dir, "prior.txt"), "prior\n");
  git(dir, ["add", "prior.txt"]);
  git(dir, ["commit", "-m", "prior"]);
  const priorSha = git(dir, ["rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(dir, "head.txt"), "head\n");
  git(dir, ["add", "head.txt"]);
  git(dir, ["commit", "-m", "head"]);
  const headSha = git(dir, ["rev-parse", "HEAD"]);

  return { dir, baseSha, priorSha, headSha };
}

test("filterBotReviews keeps only the author login", () => {
  const reviews = [
    { user: { login: "bot[bot]" }, body: "a" },
    { user: { login: "human" }, body: "b" },
  ];
  assert.deepEqual(filterBotReviews(reviews, "bot[bot]"), [reviews[0]]);
  assert.deepEqual(filterBotReviews(reviews, ""), reviews);
});

test("writeDeltaArtifacts: delta mode writes delta.json + prior-review.md", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "write-delta-"));
  const body = [
    "<!-- ai-review -->",
    formatReviewMeta({ headSha: PRIOR, baseSha: BASE, mode: "full" }),
    "finding: leak",
  ].join("\n");
  const reviews = [
    {
      id: 1,
      submitted_at: "2026-06-01T00:00:00Z",
      user: { login: "review-bot[bot]" },
      body,
    },
  ];

  const written = new Map();
  const { baseline, reviewBaseSha, artifact } = writeDeltaArtifacts({
    reviews,
    headSha: HEAD,
    mergeBaseSha: BASE,
    authorLogin: "review-bot[bot]",
    dir,
    io: {
      writeFile: (p, data) => {
        written.set(p, data);
      },
      mkdir: () => {},
      execFileSync: () => {}, // ancestor check succeeds
      log: () => {},
    },
  });

  assert.equal(baseline.mode, "delta");
  assert.equal(reviewBaseSha, PRIOR);
  assert.equal(artifact.prior_body_path, ".ai-review/prior-review.md");
  assert.equal(written.get(path.join(dir, "prior-review.md")), body);
  const delta = JSON.parse(written.get(path.join(dir, "delta.json")));
  assert.equal(delta.schema, 1);
  assert.equal(delta.mode, "delta");
  assert.equal(delta.delta_base_sha, PRIOR);
  assert.equal(delta.merge_base_sha, BASE);
  assert.equal(delta.head_sha, HEAD);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("writeDeltaArtifacts: forceFull keeps prior-review.md but full range", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "write-delta-ff-"));
  const body = [
    "<!-- ai-review -->",
    formatReviewMeta({ headSha: PRIOR, baseSha: BASE, mode: "full" }),
  ].join("\n");

  const written = new Map();
  const { baseline, reviewBaseSha } = writeDeltaArtifacts({
    reviews: [
      {
        id: 1,
        submitted_at: "2026-06-01T00:00:00Z",
        user: { login: "bot[bot]" },
        body,
      },
    ],
    headSha: HEAD,
    mergeBaseSha: BASE,
    forceFull: true,
    authorLogin: "bot[bot]",
    dir,
    io: {
      writeFile: (p, data) => {
        written.set(p, data);
      },
      mkdir: () => {},
      execFileSync: () => {},
      log: () => {},
    },
  });

  assert.equal(baseline.mode, "full");
  assert.equal(baseline.reason, "force-full-review");
  assert.equal(baseline.priorBody, body);
  assert.equal(reviewBaseSha, BASE);
  assert.ok(written.has(path.join(dir, "prior-review.md")));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("writeDeltaArtifacts: ancestor check failure → full (force-push class)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "write-delta-na-"));
  const body = [
    "<!-- ai-review -->",
    formatReviewMeta({ headSha: PRIOR, baseSha: BASE, mode: "full" }),
  ].join("\n");

  const { baseline, reviewBaseSha } = writeDeltaArtifacts({
    reviews: [
      {
        id: 1,
        submitted_at: "2026-06-01T00:00:00Z",
        user: { login: "bot[bot]" },
        body,
      },
    ],
    headSha: HEAD,
    mergeBaseSha: BASE,
    authorLogin: "bot[bot]",
    dir,
    io: {
      writeFile: () => {},
      mkdir: () => {},
      // git merge-base --is-ancestor exits non-zero → catch → false
      execFileSync: () => {
        const err = new Error("not an ancestor");
        err.status = 1;
        throw err;
      },
      log: () => {},
    },
  });

  assert.equal(baseline.mode, "full");
  assert.equal(baseline.reason, "prior-head-not-ancestor");
  assert.equal(reviewBaseSha, BASE);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("writeDeltaArtifacts: inconclusive prior meta → full", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "write-delta-inc-"));
  const body = [
    "<!-- ai-review -->",
    formatReviewMeta({
      headSha: PRIOR,
      baseSha: BASE,
      mode: "inconclusive",
    }),
  ].join("\n");

  const { baseline } = writeDeltaArtifacts({
    reviews: [
      {
        id: 1,
        submitted_at: "2026-06-01T00:00:00Z",
        user: { login: "bot[bot]" },
        body,
      },
    ],
    headSha: HEAD,
    mergeBaseSha: BASE,
    authorLogin: "bot[bot]",
    dir,
    io: {
      writeFile: () => {},
      mkdir: () => {},
      execFileSync: () => {},
      log: () => {},
    },
  });

  assert.equal(baseline.mode, "full");
  assert.equal(baseline.reason, "prior-inconclusive");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("priorHeadIsAncestorOf + writeDeltaArtifacts against a real git history", () => {
  const { dir, baseSha, priorSha, headSha } = makeLinearRepo();
  const prevCwd = process.cwd();
  try {
    process.chdir(dir);

    assert.equal(priorHeadIsAncestorOf(priorSha, headSha), true);
    assert.equal(priorHeadIsAncestorOf(headSha, priorSha), false);

    const body = [
      "<!-- ai-review -->",
      formatReviewMeta({ headSha: priorSha, baseSha, mode: "full" }),
      "## P1",
      "- old finding still open?",
    ].join("\n");

    const outDir = path.join(dir, ".ai-review");
    const { baseline, reviewBaseSha } = writeDeltaArtifacts({
      reviews: [
        {
          id: 9,
          submitted_at: "2026-08-01T00:00:00Z",
          user: { login: "mtm-bot[bot]" },
          body,
        },
      ],
      headSha,
      mergeBaseSha: baseSha,
      authorLogin: "mtm-bot[bot]",
      dir: outDir,
    });

    assert.equal(baseline.mode, "delta");
    assert.equal(baseline.reason, "prior-meta-ancestor");
    assert.equal(reviewBaseSha, priorSha);
    assert.equal(baseline.deltaBaseSha, priorSha);

    // Prep wiring: active range is prior…HEAD — only the follow-up file.
    const numstat = git(dir, ["diff", "--numstat", priorSha, headSha]);
    assert.match(numstat, /head\.txt/);
    assert.doesNotMatch(numstat, /prior\.txt/);
    assert.doesNotMatch(numstat, /base\.txt/);

    const delta = JSON.parse(
      fs.readFileSync(path.join(outDir, "delta.json"), "utf8"),
    );
    assert.equal(delta.mode, "delta");
    assert.equal(delta.delta_base_sha, priorSha);
    assert.equal(
      fs.readFileSync(path.join(outDir, "prior-review.md"), "utf8"),
      body,
    );
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeDeltaArtifacts: rewritten history (prior not ancestor) → full via real git", () => {
  const { dir, baseSha, priorSha, headSha } = makeLinearRepo();
  // Orphan commit that is not an ancestor of HEAD.
  const orphanSha = git(dir, [
    "commit-tree",
    git(dir, ["rev-parse", `${priorSha}^{tree}`]),
    "-m",
    "orphan",
  ]);
  const prevCwd = process.cwd();
  try {
    process.chdir(dir);
    assert.equal(priorHeadIsAncestorOf(orphanSha, headSha), false);

    const body = [
      "<!-- ai-review -->",
      formatReviewMeta({ headSha: orphanSha, baseSha, mode: "delta" }),
    ].join("\n");

    const { baseline, reviewBaseSha } = writeDeltaArtifacts({
      reviews: [
        {
          id: 2,
          submitted_at: "2026-08-01T00:00:00Z",
          user: { login: "bot[bot]" },
          body,
        },
      ],
      headSha,
      mergeBaseSha: baseSha,
      authorLogin: "bot[bot]",
      dir: path.join(dir, ".ai-review"),
    });

    assert.equal(baseline.mode, "full");
    assert.equal(baseline.reason, "prior-head-not-ancestor");
    assert.equal(reviewBaseSha, baseSha);
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("main: reads reviews.json env and prints shell KEY=value for prep", () => {
  const { dir, baseSha, priorSha, headSha } = makeLinearRepo();
  const prev = {
    cwd: process.cwd(),
    HEAD_SHA: process.env.HEAD_SHA,
    BASE_SHA: process.env.BASE_SHA,
    FORCE_FULL_REVIEW: process.env.FORCE_FULL_REVIEW,
    AUTHOR_LOGIN: process.env.AUTHOR_LOGIN,
    REVIEWS_JSON_PATH: process.env.REVIEWS_JSON_PATH,
  };
  const realWrite = process.stdout.write;
  try {
    process.chdir(dir);
    fs.mkdirSync(".ai-review");
    const body = [
      "<!-- ai-review -->",
      formatReviewMeta({ headSha: priorSha, baseSha, mode: "full" }),
    ].join("\n");
    fs.writeFileSync(
      ".ai-review/reviews.json",
      JSON.stringify([
        {
          id: 1,
          submitted_at: "2026-08-01T00:00:00Z",
          user: { login: "bot[bot]" },
          body,
        },
      ]),
    );

    process.env.HEAD_SHA = headSha;
    process.env.BASE_SHA = baseSha;
    process.env.FORCE_FULL_REVIEW = "false";
    process.env.AUTHOR_LOGIN = "bot[bot]";
    process.env.REVIEWS_JSON_PATH = ".ai-review/reviews.json";

    let stdout = "";
    process.stdout.write = (chunk, ...rest) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };

    main();

    assert.match(stdout, /^mode=delta$/m);
    assert.match(stdout, /^reason=prior-meta-ancestor$/m);
    assert.match(stdout, new RegExp(`^review-base-sha=${priorSha}$`, "m"));
    assert.match(stdout, new RegExp(`^delta-base-sha=${priorSha}$`, "m"));
    assert.ok(fs.existsSync(".ai-review/delta.json"));
    assert.ok(fs.existsSync(".ai-review/prior-review.md"));
  } finally {
    process.stdout.write = realWrite;
    process.chdir(prev.cwd);
    for (const [k, v] of Object.entries(prev)) {
      if (k === "cwd") continue;
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
