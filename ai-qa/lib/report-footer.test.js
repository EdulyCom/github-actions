"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { formatModelFooter, modelFromExecutionLog } = require("./report-footer.js");

test("formatModelFooter renders model and re-run hint", () => {
  const s = formatModelFooter("claude/claude-sonnet-5");
  assert.match(s, /Model: `claude\/claude-sonnet-5`/);
  assert.match(s, /Re-run this job if you need another review pass/);
});

test("formatModelFooter returns empty for blank", () => {
  assert.equal(formatModelFooter(""), "");
  assert.equal(formatModelFooter(null), "");
});

test("modelFromExecutionLog reads the first named model", () => {
  assert.equal(
    modelFromExecutionLog([
      { type: "system", subtype: "init", model: "oc/mimo-v2.5-free" },
      { type: "result", subtype: "success" },
    ]),
    "oc/mimo-v2.5-free",
  );
  assert.equal(modelFromExecutionLog(null), "");
});
