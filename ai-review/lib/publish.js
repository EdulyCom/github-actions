"use strict";

// Pure logic extracted from the Publish step's inline github-script body.
// Everything here is string/array construction with no GitHub API call, so
// it can be tested without a live model run or a live repo -- unlike the
// ~340-line step it came from, whose every prior fix (the over-tick
// collision guard, the never-untick rule) was verified only by hand against
// a real PR. The GitHub API calls (pulls.createReview, issues.addLabels,
// pulls.get, pulls.update) stay inline in action.yml: they need the
// `github`/`context` objects actions/github-script injects at runtime, and
// this module intentionally has zero I/O.

const STATUS_BLOCK_START = "<!-- ai-review-status -->";
const STATUS_BLOCK_END = "<!-- /ai-review-status -->";

// The review-stage prompt instructs the model not to prepend its own
// verdict token / confidence-merge-risk line / HTML marker to
// comment_markdown (the caller owns that banner), but model
// instruction-following is not guaranteed — strip any leading copy of
// those artifacts defensively so a non-compliant response can't
// duplicate the banner above it.
function stripLeadingBannerArtifacts(markdown) {
  if (!markdown) return markdown;
  const verdictTokenRe = /^\*\*(?:✅ PASS|❌ FAIL)\*\*\s*$/;
  const confidenceLineRe = /^Confidence:\s*\d+\s*·\s*Merge risk:\s*\S+\s*$/i;
  const htmlCommentRe = /^<!--.*-->\s*$/;
  const lines = markdown.split("\n");
  let start = 0;
  while (start < lines.length) {
    const line = lines[start];
    if (
      line.trim() === "" ||
      verdictTokenRe.test(line) ||
      confidenceLineRe.test(line) ||
      htmlCommentRe.test(line)
    ) {
      start += 1;
      continue;
    }
    break;
  }
  return lines.slice(start).join("\n");
}

/**
 * @param {{verdict: string, confidence: number, mergeRisk: string,
 *   counts: {p0:number,p1:number,p2:number,p3:number}, intentDeviated: boolean,
 *   modelVerdict: string|undefined, blockers: string[], commentBody: string}} args
 *   `commentBody` must already be run through stripLeadingBannerArtifacts.
 */
function buildReviewBody({
  verdict,
  confidence,
  mergeRisk,
  counts,
  intentDeviated,
  modelVerdict,
  blockers,
  commentBody,
}) {
  const verdictLine = verdict === "pass" ? "**✅ PASS**" : "**❌ FAIL**";
  const rejectedBanner = intentDeviated ? "❌ **Rejected — wrong solution**\n\n" : "";

  // State the machine reason for every fail. Without this, a
  // deterministic override reads as unexplained and gets attributed to
  // whatever the model happened to write about in comment_markdown —
  // exactly how issue #25 came to be filed as a test-toolchain bug.
  const reasonNote =
    verdict === "fail" && blockers.length
      ? `\n> **Why the gate failed:** ${blockers.join("; ")}.\n`
      : "";

  const mismatchNote =
    modelVerdict && modelVerdict !== verdict
      ? `\n> ⚠️ Deterministic recomputation (**${verdict}**) overrides the model's self-reported verdict (**${modelVerdict}**).\n`
      : "";

  // P2/P3 are advisory and never block (rubric.md §Severity). Say so
  // on a pass, so a reader does not wonder why nits were tolerated.
  const advisoryNote =
    verdict === "pass" && counts.p2 + counts.p3 > 0
      ? `\n> ${counts.p2} P2 / ${counts.p3} P3 finding(s) noted — non-blocking.\n`
      : "";

  return [
    "<!-- ai-review -->",
    `${rejectedBanner}${verdictLine}`,
    ...(mismatchNote ? [mismatchNote] : []),
    ...(reasonNote ? [reasonNote] : []),
    ...(advisoryNote ? [advisoryNote] : []),
    "",
    `Confidence: ${confidence} · Merge risk: ${mergeRisk}`,
    `P0: ${counts.p0} · P1: ${counts.p1} · P2: ${counts.p2} · P3: ${counts.p3}`,
    "",
    commentBody || "_No review content returned._",
  ].join("\n");
}

/** @param {string} salvaged possibly-empty text recovered from a missed structured output. */
function buildInconclusiveBody(salvaged) {
  return [
    "<!-- ai-review -->",
    "### ⚠️ AI Review — inconclusive (re-run required)",
    "",
    "The review model did not return a structured result after a",
    "resume-repair attempt and a full retry (a known intermittent",
    "`anthropics/claude-code-action` issue). This is **not** a",
    "code-quality judgment — the review did not complete, so the gate",
    "fails closed.",
    "",
    "**Re-run the `ai-review` job** to get a verdict.",
    ...(salvaged
      ? [
          "",
          "<details><summary>Unstructured model output recovered from the run (not a verdict)</summary>",
          "",
          salvaged,
          "",
          "</details>",
        ]
      : []),
  ].join("\n");
}

/**
 * Ticks unchecked PR-body checkboxes whose text matches a VERIFIED checklist
 * item. Never unchecks a human-checked box (the regex only matches "[ ]").
 * @param {string} originalBody
 * @param {{text: string, status: string, evidence?: string}[]} checklist
 * @returns {{newBody: string, ticks: number}}
 */
function tickVerifiedBoxes(originalBody, checklist) {
  const norm = (s) =>
    (s || "")
      .toLowerCase()
      .replace(/[`*_~]/g, "")
      .replace(/\s+/g, " ")
      .replace(/[.:;,\s]+$/, "")
      .trim();

  // Count verified items per normalized text, so we tick AT MOST as
  // many boxes as there were verified items with that text. This
  // stops one verified item from ticking several distinct boxes that
  // happen to normalize identically (over-tick collision).
  const verifiedCounts = new Map();
  for (const i of checklist) {
    if (i && i.status === "verified" && i.text) {
      const k = norm(i.text);
      verifiedCounts.set(k, (verifiedCounts.get(k) || 0) + 1);
    }
  }

  const checkboxRe = /^(\s*[-*]\s*)\[ \](\s*)(.+)$/;
  let ticks = 0;
  const newBody = originalBody
    .split("\n")
    .map((line) => {
      const m = line.match(checkboxRe);
      if (m) {
        const k = norm(m[3]);
        const remaining = verifiedCounts.get(k) || 0;
        if (remaining > 0) {
          verifiedCounts.set(k, remaining - 1);
          ticks += 1;
          return `${m[1]}[x]${m[2]}${m[3]}`;
        }
      }
      return line;
    })
    .join("\n");

  return { newBody, ticks };
}

/**
 * @param {{checklist: {text:string,status:string,evidence?:string}[],
 *   verificationEvidence: {command:string,result?:string}[], verdict: string}} args
 */
function buildStatusBlock({ checklist, verificationEvidence, verdict }) {
  const icon = (s) => (s === "verified" ? "✅" : s === "failed" ? "❌" : "❔");
  const itemLines = checklist
    .filter((i) => i && i.text)
    .map(
      (i) => `- ${icon(i.status)} ${i.text}${i.evidence ? ` — ${i.evidence}` : ""}`
    );
  const evLines = verificationEvidence
    .filter((e) => e && e.command)
    .map((e) => `- \`${e.command}\`${e.result ? ` → ${e.result}` : ""}`);

  const blockParts = [STATUS_BLOCK_START, "#### 🤖 AI Review — checklist verification", ...itemLines];
  if (evLines.length) {
    blockParts.push("", "_Verification evidence:_", ...evLines);
  }
  blockParts.push("", `_Last updated by ai-review · verdict: ${verdict}._`, STATUS_BLOCK_END);
  return blockParts.join("\n");
}

/** Replaces an existing managed status block in place, or appends a new one. */
function upsertStatusBlock(body, block) {
  const blockRe = new RegExp(`${STATUS_BLOCK_START}[\\s\\S]*?${STATUS_BLOCK_END}`);
  if (blockRe.test(body)) {
    return body.replace(blockRe, block);
  }
  return `${body.replace(/\s*$/, "")}\n\n${block}\n`;
}

module.exports = {
  stripLeadingBannerArtifacts,
  buildReviewBody,
  buildInconclusiveBody,
  tickVerifiedBoxes,
  buildStatusBlock,
  upsertStatusBlock,
};
