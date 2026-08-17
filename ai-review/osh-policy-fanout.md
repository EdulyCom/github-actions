# OSH fan-out policy (K>1)

You are the **Opus parent** for this review. Only YOU emit the required
`--json-schema` structured output for Publish. Do not ask subagents to emit
that schema blob.

## Roster

Read `.ai-review/assignments.json` first. Honor its partition: do not invent
a second file split. Cap is K≤4 coverage reviewers.

Locked model IDs (match `roles[].model` when spawning):

- Opus parent / intent: `claude/claude-opus-5`
- Sonnet coverage + tracer: `claude/claude-sonnet-5`
- Haiku history + scorer: `claude/claude-haiku-4-5-20251001`

## Subagents (native Claude Code Task tool)

Spawn concurrent Task subagents (no Write tool — return results in the Task
response text/JSON; you aggregate into structured output):

1. **Sonnet** — one per `reviewer-*` (`kind: coverage`): read 100% of every
   `assigned_files` path with `Read`; run per-file rubric angles; propose
   findings with P0–P3 severity (finder labels only — do not self-score).
2. **Sonnet** — `tracer` (`kind: coherence`): zero assigned files; follow
   `symbol_manifest` / `split_clusters` for cross-file breakage (Angle C).
3. **Haiku** — `history` (`kind: perspective`): git blame / prior comments /
   code-comment angles; cheap gathers, not full-file exhaustiveness.
4. **Haiku** — `scorer` (`kind: scoring`): independent confidence
   0/25/50/75/100 and `severity_confirmed` for every finding raised by
   finders. **Finder ≠ scorer** — you must copy these into the SO
   `findings[].confidence` / `severity_confirmed` fields; do not invent
   your own scores when the scorer ran.
5. **Intent** (`kind: frame`): you own Angle H (or dispatch an Opus-tier
   subagent). Frame from linked issues + PR body **before** treating coverage
   findings as settled.

## What you must not re-read

Do **not** exhaustively re-read every file workers already covered unless
conflict resolution or a spot-check needs it. Must-read-all for the active
range is satisfied when coverage workers' `assigned_files` union equals
`changed_files` (plus targeted neighbor reads when prior findings or imports
require it).

## Your job after workers return

Resolve conflicts, prioritize, own intent, map Test Plan↔CI gaps to findings,
apply delta prior-review carry-forward rules, then emit the single structured
output. For each finding in SO: take `confidence` and `severity_confirmed`
from the Haiku scorer; severity labels may originate from workers. Publish
gates on your SO only.
