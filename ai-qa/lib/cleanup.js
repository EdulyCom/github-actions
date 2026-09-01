"use strict";

// Post-merge delivery hygiene. Extracted so "was this delivered?" and
// leftover cleanup are unit-testable without a live GitHub API or model
// run — the same reason ai-review extracted recompute.js (issue #25).
// GitHub I/O stays in action.yml.
//
// Mirrors finishing-a-development-branch: verify success before removing
// anything, and only clean up what this action owns.

function isTrue(v) {
  return v === true || v === "true";
}

/**
 * @param {{
 *   eventName?: string,
 *   eventAction?: string,
 *   issueIsPr?: boolean|string,
 *   prMerged?: boolean|string,
 * }} opts
 * @returns {{ mode: 'merged-delivery'|'unmerged-close'|'issue-closed'|'skip', reason: string }}
 */
function resolveMode(opts) {
  const o = opts || {};
  const eventName = o.eventName || "";
  if (eventName === "issues") {
    if (isTrue(o.issueIsPr)) {
      return { mode: "skip", reason: "issue-event-is-pr" };
    }
    return { mode: "issue-closed", reason: "issue-closed" };
  }
  if (eventName === "pull_request") {
    if (o.eventAction !== "closed") {
      return { mode: "skip", reason: "pr-not-closed" };
    }
    if (isTrue(o.prMerged)) {
      return { mode: "merged-delivery", reason: "pr-merged" };
    }
    return { mode: "unmerged-close", reason: "pr-closed-unmerged" };
  }
  if (eventName === "push") {
    return { mode: "merged-delivery", reason: "push" };
  }
  return { mode: "skip", reason: "unsupported-event" };
}

/**
 * @param {{
 *   cleanupEnabled?: boolean,
 *   deliveryOk?: boolean,
 *   merged?: boolean|string,
 *   headRef?: string,
 *   defaultBranch?: string,
 *   isCrossRepository?: boolean,
 *   otherOpenPrCount?: number,
 * }} opts
 * @returns {{ delete: boolean, reason: string }}
 */
function shouldDeleteHeadBranch(opts) {
  const o = opts || {};
  if (o.cleanupEnabled === false) {
    return { delete: false, reason: "cleanup-disabled" };
  }
  const headRef = typeof o.headRef === "string" ? o.headRef.trim() : "";
  if (!headRef) {
    return { delete: false, reason: "no-head-ref" };
  }
  const defaultBranch =
    typeof o.defaultBranch === "string" ? o.defaultBranch.trim() : "";
  if (defaultBranch && headRef.toLowerCase() === defaultBranch.toLowerCase()) {
    return { delete: false, reason: "default-branch" };
  }
  if (o.isCrossRepository) {
    return { delete: false, reason: "fork-head" };
  }
  const other = Number(o.otherOpenPrCount) || 0;
  if (other > 0) {
    return { delete: false, reason: "still-in-use" };
  }
  // Unmerged close: GitHub never auto-deletes these. No delivery gate.
  if (o.merged === false || o.merged === "false") {
    return { delete: true, reason: "closed-unmerged" };
  }
  if (!o.deliveryOk) {
    return { delete: false, reason: "delivery-not-verified" };
  }
  return { delete: true, reason: "merged-and-delivered" };
}

/**
 * @param {{ deliveryOk?: boolean, linkedToThisPr?: boolean }} opts
 * @returns {{ close: boolean, reason: string }}
 */
function shouldCloseIssue(opts) {
  const o = opts || {};
  if (!o.linkedToThisPr) {
    return { close: false, reason: "not-linked" };
  }
  if (!o.deliveryOk) {
    return { close: false, reason: "delivery-not-verified" };
  }
  return { close: true, reason: "delivered" };
}

/**
 * @param {{
 *   closedByThisAction?: boolean,
 *   hasPassLabel?: boolean,
 *   stateReason?: string|null,
 *   linkedUndeliveredPr?: boolean,
 *   updateLinkedIssues?: boolean|string,
 * }} opts
 * @returns {{ reopen: boolean, reason: string }}
 */
function shouldReopenPrematureClose(opts) {
  const o = opts || {};
  // Explicit false only — omit/undefined keeps the action.yml default (on).
  if (o.updateLinkedIssues === false || o.updateLinkedIssues === "false") {
    return { reopen: false, reason: "update-linked-issues-off" };
  }
  if (o.closedByThisAction) {
    return { reopen: false, reason: "closed-by-this-action" };
  }
  if (o.hasPassLabel) {
    return { reopen: false, reason: "already-delivered" };
  }
  if (String(o.stateReason || "").toLowerCase() === "not_planned") {
    return { reopen: false, reason: "not-planned" };
  }
  if (!o.linkedUndeliveredPr) {
    return { reopen: false, reason: "no-undelivered-pr" };
  }
  return { reopen: true, reason: "closed-before-delivery" };
}

/**
 * @param {{ number?: number, merged?: boolean, labels?: string[] }[]} prs
 * @param {string} passLabel
 * @returns {boolean}
 */
function linkedUndeliveredPr(prs, passLabel) {
  if (!Array.isArray(prs)) return false;
  const label = passLabel || "";
  return prs.some((p) => {
    if (!p || !p.merged) return false;
    const labels = Array.isArray(p.labels) ? p.labels : [];
    return !labels.includes(label);
  });
}

module.exports = {
  resolveMode,
  shouldDeleteHeadBranch,
  shouldCloseIssue,
  shouldReopenPrematureClose,
  linkedUndeliveredPr,
};
