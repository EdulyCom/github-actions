"use strict";

/**
 * @param {string|null|undefined} modelUsed
 * @returns {string} empty when modelUsed is blank
 */
function formatModelFooter(modelUsed) {
  if (!modelUsed || typeof modelUsed !== "string" || !modelUsed.trim()) return "";
  return [
    `Model: \`${modelUsed.trim()}\``,
    "_Re-run this job if you need another review pass._",
  ].join("\n");
}

/**
 * First named model in a claude-code-action execution log.
 * @param {unknown} entries
 * @returns {string}
 */
function modelFromExecutionLog(entries) {
  if (!Array.isArray(entries)) return "";
  for (const e of entries) {
    if (e && typeof e.model === "string" && e.model.trim()) return e.model.trim();
  }
  return "";
}

module.exports = { formatModelFooter, modelFromExecutionLog };
