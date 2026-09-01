"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveMode,
  shouldDeleteHeadBranch,
  shouldCloseIssue,
  shouldReopenPrematureClose,
  linkedUndeliveredPr,
} = require("./cleanup.js");

// --- resolveMode ------------------------------------------------------------

test("push is merged-delivery (legacy caller alias)", () => {
  const r = resolveMode({ eventName: "push" });
  assert.equal(r.mode, "merged-delivery");
});

test("pull_request closed + merged is merged-delivery", () => {
  const r = resolveMode({
    eventName: "pull_request",
    eventAction: "closed",
    prMerged: "true",
  });
  assert.equal(r.mode, "merged-delivery");
});

test("pull_request closed without merge is unmerged-close", () => {
  const r = resolveMode({
    eventName: "pull_request",
    eventAction: "closed",
    prMerged: false,
  });
  assert.equal(r.mode, "unmerged-close");
});

test("issues.closed on a real issue is issue-closed", () => {
  const r = resolveMode({ eventName: "issues", issueIsPr: false });
  assert.equal(r.mode, "issue-closed");
});

test("issues.closed on a pull request is skipped (PRs are issues)", () => {
  const r = resolveMode({ eventName: "issues", issueIsPr: "true" });
  assert.equal(r.mode, "skip");
  assert.equal(r.reason, "issue-event-is-pr");
});

test("unsupported events skip", () => {
  assert.equal(resolveMode({ eventName: "workflow_dispatch" }).mode, "skip");
  assert.equal(
    resolveMode({ eventName: "pull_request", eventAction: "opened" }).mode,
    "skip"
  );
});

// --- shouldDeleteHeadBranch -------------------------------------------------

const del = (over) =>
  Object.assign(
    {
      cleanupEnabled: true,
      deliveryOk: true,
      merged: true,
      headRef: "feat/widget",
      defaultBranch: "main",
      isCrossRepository: false,
      otherOpenPrCount: 0,
    },
    over
  );

test("deletes merged head after delivery PASS", () => {
  const d = shouldDeleteHeadBranch(del());
  assert.equal(d.delete, true);
  assert.equal(d.reason, "merged-and-delivered");
});

test("keeps merged head when delivery failed", () => {
  const d = shouldDeleteHeadBranch(del({ deliveryOk: false }));
  assert.equal(d.delete, false);
  assert.equal(d.reason, "delivery-not-verified");
});

test("deletes unmerged closed head without a delivery gate", () => {
  const d = shouldDeleteHeadBranch(del({ merged: false, deliveryOk: false }));
  assert.equal(d.delete, true);
  assert.equal(d.reason, "closed-unmerged");
});

test("never deletes the default branch", () => {
  assert.equal(shouldDeleteHeadBranch(del({ headRef: "main" })).delete, false);
  assert.equal(
    shouldDeleteHeadBranch(del({ headRef: "Main", defaultBranch: "main" })).reason,
    "default-branch"
  );
});

test("never deletes a fork head", () => {
  const d = shouldDeleteHeadBranch(del({ isCrossRepository: true, merged: false }));
  assert.equal(d.delete, false);
  assert.equal(d.reason, "fork-head");
});

test("keeps a head still used by another open PR", () => {
  const d = shouldDeleteHeadBranch(del({ merged: false, otherOpenPrCount: 2 }));
  assert.equal(d.delete, false);
  assert.equal(d.reason, "still-in-use");
});

test("honors cleanupEnabled=false", () => {
  const d = shouldDeleteHeadBranch(del({ cleanupEnabled: false, merged: false }));
  assert.equal(d.delete, false);
  assert.equal(d.reason, "cleanup-disabled");
});

test("skips empty head ref", () => {
  assert.equal(shouldDeleteHeadBranch(del({ headRef: "  " })).reason, "no-head-ref");
});

// --- shouldCloseIssue -------------------------------------------------------

test("closes a linked issue only after delivery PASS", () => {
  const d = shouldCloseIssue({ deliveryOk: true, linkedToThisPr: true });
  assert.equal(d.close, true);
  assert.equal(d.reason, "delivered");
});

test("does not close on FAIL — leave open (merge is not done)", () => {
  const d = shouldCloseIssue({ deliveryOk: false, linkedToThisPr: true });
  assert.equal(d.close, false);
  assert.equal(d.reason, "delivery-not-verified");
});

test("does not close issues that were not linked to this PR", () => {
  const d = shouldCloseIssue({ deliveryOk: true, linkedToThisPr: false });
  assert.equal(d.close, false);
  assert.equal(d.reason, "not-linked");
});

// --- shouldReopenPrematureClose ---------------------------------------------

test("reopens when a human/GitHub closed an issue linked to an undelivered PR", () => {
  const d = shouldReopenPrematureClose({
    closedByThisAction: false,
    hasPassLabel: false,
    stateReason: "completed",
    linkedUndeliveredPr: true,
  });
  assert.equal(d.reopen, true);
  assert.equal(d.reason, "closed-before-delivery");
});

test("does not reopen its own close (avoids the PASS-close loop)", () => {
  const d = shouldReopenPrematureClose({
    closedByThisAction: true,
    hasPassLabel: true,
    linkedUndeliveredPr: false,
  });
  assert.equal(d.reopen, false);
  assert.equal(d.reason, "closed-by-this-action");
});

test("does not reopen when the issue already has the PASS label", () => {
  const d = shouldReopenPrematureClose({
    closedByThisAction: false,
    hasPassLabel: true,
    linkedUndeliveredPr: true,
  });
  assert.equal(d.reopen, false);
  assert.equal(d.reason, "already-delivered");
});

test("does not reopen not_planned closes", () => {
  const d = shouldReopenPrematureClose({
    closedByThisAction: false,
    hasPassLabel: false,
    stateReason: "not_planned",
    linkedUndeliveredPr: true,
  });
  assert.equal(d.reopen, false);
  assert.equal(d.reason, "not-planned");
});

test("does not reopen when no linked undelivered PR exists", () => {
  const d = shouldReopenPrematureClose({
    closedByThisAction: false,
    hasPassLabel: false,
    stateReason: "completed",
    linkedUndeliveredPr: false,
  });
  assert.equal(d.reopen, false);
  assert.equal(d.reason, "no-undelivered-pr");
});

test("does not reopen when update-linked-issues is off", () => {
  const base = {
    closedByThisAction: false,
    hasPassLabel: false,
    stateReason: "completed",
    linkedUndeliveredPr: true,
  };
  const off = shouldReopenPrematureClose({
    ...base,
    updateLinkedIssues: false,
  });
  assert.equal(off.reopen, false);
  assert.equal(off.reason, "update-linked-issues-off");

  const offStr = shouldReopenPrematureClose({
    ...base,
    updateLinkedIssues: "false",
  });
  assert.equal(offStr.reopen, false);
  assert.equal(offStr.reason, "update-linked-issues-off");

  // Omit the flag (and the action.yml default of true) — still reopen.
  const omitted = shouldReopenPrematureClose(base);
  assert.equal(omitted.reopen, true);
  assert.equal(omitted.reason, "closed-before-delivery");
});

// --- linkedUndeliveredPr ----------------------------------------------------

test("linkedUndeliveredPr is true when a merged PR lacks the pass label", () => {
  assert.equal(
    linkedUndeliveredPr(
      [
        { number: 8, merged: true, labels: ["bug"] },
        { number: 9, merged: false, labels: [] },
      ],
      "✓ /ai-qa"
    ),
    true
  );
});

test("linkedUndeliveredPr is false when every merged PR already has PASS", () => {
  assert.equal(
    linkedUndeliveredPr(
      [{ number: 8, merged: true, labels: ["✓ /ai-qa"] }],
      "✓ /ai-qa"
    ),
    false
  );
});

test("linkedUndeliveredPr is false when there are no merged PRs", () => {
  assert.equal(
    linkedUndeliveredPr([{ number: 8, merged: false, labels: [] }], "✓ /ai-qa"),
    false
  );
});
