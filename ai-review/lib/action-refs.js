"use strict";

// Structural guards for ai-review/action.yml's composite-action step graph.
// Nothing else catches a duplicate `id:` or a `steps.<id>.` reference to a
// step that doesn't exist — YAML is still valid, actions/runner only fails
// at run time (and only on the exact code path that hits the bad reference),
// so a typo here has shipped to production before. Pure text-level checks:
// this repo takes no YAML-parsing dependency, and the file's step shape
// (4-space `- name:`, 6-space sub-keys) is consistent enough that a couple
// of regexes cover it without one.

const ID_DECL_RE = /^ {6}id: (\S+)\s*$/gm;
const STEP_REF_RE = /steps\.([\w-]+)\./g;

function extractDeclaredIds(yamlText) {
  const ids = [];
  for (const m of yamlText.matchAll(ID_DECL_RE)) ids.push(m[1]);
  return ids;
}

function extractReferencedIds(yamlText) {
  const ids = new Set();
  for (const m of yamlText.matchAll(STEP_REF_RE)) ids.add(m[1]);
  return [...ids];
}

function findDuplicateIds(yamlText) {
  const seen = new Set();
  const dupes = new Set();
  for (const id of extractDeclaredIds(yamlText)) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

function findDanglingRefs(yamlText) {
  const declared = new Set(extractDeclaredIds(yamlText));
  return extractReferencedIds(yamlText).filter((id) => !declared.has(id));
}

module.exports = {
  extractDeclaredIds,
  extractReferencedIds,
  findDuplicateIds,
  findDanglingRefs,
};
