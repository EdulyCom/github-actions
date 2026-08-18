"use strict";

// Deterministic context.md for the Review stage — no model call.
//
// Written during prep so Review always has a factual handoff even when the
// optional Haiku Context stage is skipped (delta + K≤1) or stalls. Haiku may
// overwrite this file when it runs; if it fails without writing, this baseline
// remains. Pure formatting + a thin fs write; unit-tested.

const fs = require("node:fs");

/**
 * @param {{
 *   review_mode?: string,
 *   file_count?: number,
 *   churn?: number,
 *   total_fullfile_bytes?: number,
 *   changed_files?: string[],
 *   symbol_manifest?: Array<{ kind?: string, name?: string, file?: string }>,
 *   has_test_change?: boolean,
 *   has_logic_change?: boolean,
 *   no_tests_for_changed_logic?: boolean,
 *   delta_base_sha?: string|null,
 *   base_sha?: string|null,
 *   head_sha?: string|null,
 * }} manifest
 * @param {{ k?: number, roles?: Array<{ role?: string, assigned_files?: string[] }> } | null} [roster]
 * @returns {string}
 */
function formatDeterministicContext(manifest, roster) {
  const m = manifest && typeof manifest === "object" ? manifest : {};
  const mode = m.review_mode === "delta" ? "delta" : "full";
  const files = Array.isArray(m.changed_files) ? m.changed_files : [];
  const symbols = Array.isArray(m.symbol_manifest) ? m.symbol_manifest : [];
  const k = roster && Number.isFinite(Number(roster.k)) ? Number(roster.k) : null;

  const lines = [];
  lines.push("# Review context (deterministic prep)");
  lines.push("");
  lines.push(
    "Generated without a model call from `.ai-review/manifest.json` (and roster when present). " +
      "Factual inventory only — not a review. The Review stage uses a /code-review " +
      "mindset: start from the git diff and expand to full-file reads only when a " +
      "finding cannot be judged from the hunk — not every changed file end-to-end.",
  );
  lines.push("");
  lines.push("## Range");
  lines.push("");
  lines.push(`- review_mode: \`${mode}\``);
  if (mode === "delta" && m.delta_base_sha) {
    lines.push(`- active diff base (prior published head): \`${m.delta_base_sha}\``);
  } else if (m.base_sha) {
    lines.push(`- active diff base (merge-base): \`${m.base_sha}\``);
  }
  if (m.head_sha) lines.push(`- head: \`${m.head_sha}\``);
  lines.push(
    `- scope: ${Number(m.file_count) || files.length} file(s), churn ${Number(m.churn) || 0}, ` +
      `${Number(m.total_fullfile_bytes) || 0} bytes at HEAD` +
      (k != null ? `, roster K=${k}` : ""),
  );
  lines.push("");
  lines.push("## What changed");
  lines.push("");
  if (files.length === 0) {
    lines.push("_Empty diff — no changed files in the active range._");
  } else {
    for (const p of files) lines.push(`- \`${p}\``);
  }
  lines.push("");
  lines.push("## Symbols (from diff hunk headers)");
  lines.push("");
  if (symbols.length === 0) {
    lines.push("_None extracted — Review should Grep from file contents as needed._");
  } else {
    for (const s of symbols) {
      const kind = s.kind || "symbol";
      const name = s.name || "?";
      const file = s.file || "?";
      lines.push(`- \`${kind}\` **${name}** in \`${file}\``);
    }
  }
  lines.push("");
  lines.push("## Flags");
  lines.push("");
  lines.push(`- has_logic_change: ${Boolean(m.has_logic_change)}`);
  lines.push(`- has_test_change: ${Boolean(m.has_test_change)}`);
  lines.push(`- no_tests_for_changed_logic: ${Boolean(m.no_tests_for_changed_logic)}`);
  lines.push("");

  if (roster && Array.isArray(roster.roles) && roster.roles.length > 0) {
    lines.push("## Roster assignments");
    lines.push("");
    for (const role of roster.roles) {
      const name = role.role || "role";
      const assigned = Array.isArray(role.assigned_files) ? role.assigned_files : [];
      if (assigned.length === 0) {
        lines.push(`- **${name}**: _(no file assignment)_`);
      } else {
        lines.push(`- **${name}**: ${assigned.map((p) => `\`${p}\``).join(", ")}`);
      }
    }
    lines.push("");
  }

  lines.push("## Reviewer notes");
  lines.push("");
  lines.push(
    "- Prefer Grep/Glob for callers, callees, and shared helpers of the symbols above; " +
      "this file does not replace those reads.",
  );
  if (mode === "delta") {
    lines.push(
      "- Delta mode: review the active prior_head…HEAD diff; expand to full " +
        "file or neighbor reads when prior findings or imports require it.",
    );
  }
  lines.push("");
  return `${lines.join("\n")}`;
}

/**
 * Write `context.md` at the repository root (Review stage path).
 *
 * @param {object} manifest
 * @param {object|null} [roster]
 * @param {{ writeFile?: Function, path?: string }} [io]
 * @returns {string} absolute-or-relative path written
 */
function writeDeterministicContext(manifest, roster, io) {
  const writeFile = (io && io.writeFile) || fs.writeFileSync;
  const outPath = (io && io.path) || "context.md";
  const body = formatDeterministicContext(manifest, roster);
  writeFile(outPath, body);
  return outPath;
}

module.exports = {
  formatDeterministicContext,
  writeDeterministicContext,
};
