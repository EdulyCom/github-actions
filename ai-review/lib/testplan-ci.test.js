"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  extractTestPlanItems,
  extractTestPlanSection,
  summarizeCiChecks,
  findObviousUncoveredItems,
  writeTestPlanCiArtifacts,
} = require("./testplan-ci.js");

// --- extractTestPlanItems --------------------------------------------------

test("extractTestPlanItems: Test Plan section checkboxes", () => {
  const body = [
    "## Summary",
    "- [ ] Not a plan item",
    "",
    "## Test Plan",
    "- [ ] Unit tests for parser",
    "- [x] CI green on PR",
    "",
    "## Notes",
    "- [ ] Ignored after section",
  ].join("\n");

  assert.deepEqual(extractTestPlanItems(body), [
    "Unit tests for parser",
    "CI green on PR",
  ]);
});

test("extractTestPlanItems: plain bullets under Test Plan when no checkboxes", () => {
  const body = [
    "## Test Plan",
    "- Run unit suite",
    "1. Manual smoke on staging",
  ].join("\n");

  assert.deepEqual(extractTestPlanItems(body), [
    "Run unit suite",
    "Manual smoke on staging",
  ]);
});

test("extractTestPlanItems: unions checkboxes with plain/numbered in same section", () => {
  const body = [
    "## Test Plan",
    "- [ ] Automated unit suite",
    "- Manual smoke on staging",
    "2. Load-test the API",
  ].join("\n");

  assert.deepEqual(extractTestPlanItems(body), [
    "Automated unit suite",
    "Manual smoke on staging",
    "Load-test the API",
  ]);
});

test("extractTestPlanItems: empty Test Plan section falls back to body checkboxes", () => {
  const body = [
    "## Summary",
    "- [ ] Outside checklist item",
    "",
    "## Test Plan",
    "See checklist above.",
    "",
    "## Notes",
    "- [x] Another outside item",
  ].join("\n");

  assert.deepEqual(extractTestPlanItems(body), [
    "Outside checklist item",
    "Another outside item",
  ]);
});

test("extractTestPlanItems: falls back to all body checkboxes without section", () => {
  const body = [
    "Please verify:",
    "- [ ] Handles empty input",
    "* [x] Docs updated",
  ].join("\n");

  assert.deepEqual(extractTestPlanItems(body), [
    "Handles empty input",
    "Docs updated",
  ]);
});

test("extractTestPlanItems: dedupes same text checked and unchecked", () => {
  const body = [
    "## Test Plan",
    "- [ ] Handles empty input",
    "- [x] Handles empty input",
  ].join("\n");

  assert.deepEqual(extractTestPlanItems(body), ["Handles empty input"]);
});

test("extractTestPlanItems: empty / non-string → []", () => {
  assert.deepEqual(extractTestPlanItems(""), []);
  assert.deepEqual(extractTestPlanItems(null), []);
  assert.deepEqual(extractTestPlanItems(undefined), []);
});

test("extractTestPlanSection stops at next same-or-higher heading", () => {
  const body = [
    "### Test Plan",
    "- [ ] A",
    "#### Nested",
    "- [ ] B",
    "## Other",
    "- [ ] C",
  ].join("\n");
  const section = extractTestPlanSection(body);
  assert.match(section, /A/);
  assert.match(section, /B/);
  assert.doesNotMatch(section, /C/);
  assert.deepEqual(extractTestPlanItems(body), ["A", "B"]);
});

// --- summarizeCiChecks -----------------------------------------------------

test("summarizeCiChecks maps name/conclusion/status", () => {
  assert.deepEqual(
    summarizeCiChecks([
      { name: "lint", conclusion: "success", status: "completed" },
      { name: "test", conclusion: null, status: "in_progress" },
      { name: "", status: "completed" },
      null,
    ]),
    [
      { name: "lint", conclusion: "success", status: "completed" },
      { name: "test", conclusion: null, status: "in_progress" },
    ],
  );
});

test("summarizeCiChecks: non-array → []", () => {
  assert.deepEqual(summarizeCiChecks(null), []);
  assert.deepEqual(summarizeCiChecks({}), []);
});

test("summarizeCiChecks: duplicate names keep the terminal row", () => {
  assert.deepEqual(
    summarizeCiChecks([
      { name: "lint", conclusion: null, status: "in_progress" },
      { name: "test", conclusion: null, status: "queued" },
      { name: "lint", conclusion: "success", status: "completed" },
      { name: "test", conclusion: "failure", status: "completed" },
    ]),
    [
      { name: "lint", conclusion: "success", status: "completed" },
      { name: "test", conclusion: "failure", status: "completed" },
    ],
  );
});

// --- findObviousUncoveredItems ---------------------------------------------

test("findObviousUncoveredItems: keyword overlap vs obvious miss", () => {
  const items = [
    "Unit tests for auth login",
    "Deploy to production manually",
  ];
  const checks = [
    { name: "unit / auth", conclusion: "success", status: "completed" },
  ];
  assert.deepEqual(findObviousUncoveredItems(items, checks), [
    "Deploy to production manually",
  ]);
});

test("findObviousUncoveredItems: empty checks → all items uncovered", () => {
  assert.deepEqual(findObviousUncoveredItems(["A thing"], []), ["A thing"]);
});

// --- writeTestPlanCiArtifacts ----------------------------------------------

test("writeTestPlanCiArtifacts writes both JSON shapes", () => {
  const written = new Map();
  const { items, checks } = writeTestPlanCiArtifacts({
    prBody: "## Test Plan\n- [ ] Parser edge cases\n",
    checkRuns: [
      { name: "ci / test", conclusion: "success", status: "completed" },
    ],
    dir: "/tmp/fake-ai-review",
    io: {
      writeFile: (p, data) => {
        written.set(p, data);
      },
      mkdir: () => {},
      log: () => {},
    },
  });

  assert.deepEqual(items, ["Parser edge cases"]);
  assert.equal(checks.length, 1);

  const plan = JSON.parse(
    written.get(path.join("/tmp/fake-ai-review", "test-plan-items.json")),
  );
  const ci = JSON.parse(
    written.get(path.join("/tmp/fake-ai-review", "ci-checks.json")),
  );
  assert.equal(plan.schema, 1);
  assert.deepEqual(plan.items, ["Parser edge cases"]);
  assert.equal(ci.schema, 1);
  assert.deepEqual(ci.checks, [
    { name: "ci / test", conclusion: "success", status: "completed" },
  ]);
});

test("main: reads env paths and writes Test Plan/CI artifacts", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const { main } = require("./testplan-ci.js");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "testplan-ci-main-"));
  try {
    fs.writeFileSync(
      path.join(dir, "pr-body.md"),
      "## Test Plan\n- [ ] Unit tests for parser\n",
    );
    fs.writeFileSync(
      path.join(dir, "check-runs.raw.json"),
      JSON.stringify([
        {
          name: "ci / test",
          conclusion: "success",
          status: "completed",
        },
      ]),
    );

    const prev = {
      AI_REVIEW_DIR: process.env.AI_REVIEW_DIR,
      PR_BODY_PATH: process.env.PR_BODY_PATH,
      CHECK_RUNS_PATH: process.env.CHECK_RUNS_PATH,
    };
    process.env.AI_REVIEW_DIR = dir;
    process.env.PR_BODY_PATH = path.join(dir, "pr-body.md");
    process.env.CHECK_RUNS_PATH = path.join(dir, "check-runs.raw.json");
    try {
      main();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    const plan = JSON.parse(
      fs.readFileSync(path.join(dir, "test-plan-items.json"), "utf8"),
    );
    const ci = JSON.parse(
      fs.readFileSync(path.join(dir, "ci-checks.json"), "utf8"),
    );
    assert.deepEqual(plan.items, ["Unit tests for parser"]);
    assert.equal(ci.checks.length, 1);
    assert.equal(ci.checks[0].name, "ci / test");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
