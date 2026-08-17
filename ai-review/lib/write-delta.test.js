"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  filterBotReviews,
  writeDeltaArtifacts,
} = require("./write-delta.js");
const { formatReviewMeta } = require("./delta.js");

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PRIOR = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BASE = "cccccccccccccccccccccccccccccccccccccccc";

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
