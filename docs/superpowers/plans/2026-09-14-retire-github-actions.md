# Retire github-actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fully retire EdulyCom/github-actions and remove all callers, preserving consumer intent via Bugbot + two Cursor Automations + native GitHub settings.

**Architecture:** Merge-only gate via required Cursor Bugbot check. Auto-assign and unmerged-PR branch delete via two shared Cursor Automations. Issue close + merged-branch delete via GitHub native settings. Archive the actions repo after soak.

**Tech Stack:** Cursor Bugbot, Cursor Automations, GitHub rulesets/branch protection, per-repo `.github/workflows` edits (`gh`).

## Global Constraints

- Cutover: add Bugbot required check and prove it before removing review-gate / old AI required contexts
- Enable Bugbot fail-on-unresolved where available (default `neutral` does not block merges)
- Orgs: EdulyCom, Lagn-App, aikstudio must have Cursor/Bugbot installed
- Automations authored via Agents Window Automate skill when `open_automation` is available
- Do not port OSH/delta/rubric/health/premature-reopen
- Spec: `docs/superpowers/specs/2026-09-14-retire-github-actions-design.md`

---

### Task 1: Persist design + plan docs

- [ ] Ensure design + plan files exist under `docs/superpowers/`

### Task 2: Enable Bugbot + merge gate

- [ ] Verify Cursor/Bugbot App access per org
- [ ] Enable Bugbot on each of the six consumer repos
- [ ] Add Cursor Bugbot to required checks; enable fail-on-unresolved when available
- [ ] Prove on a sample PR per org before stripping Actions gates

### Task 3: Create two shared Cursor Automations

- [ ] Auto-assign: PR opened/ready; all six repos; skip bots / existing assignees
- [ ] Branch cleanup: PR closed unmerged; safe head delete

### Task 4: Native GitHub settings

- [ ] Enable auto-close issues with merged linked PRs on all six
- [ ] Enable automatically delete head branches on all six

### Task 5: Strip callers (order: template → payload → aik → lagn → ezzu → eduly)

- [ ] Per repo: remove `uses: EdulyCom/github-actions/...`, review-gate jobs, `needs:` edges, `ai-qa.yml`, gate vars logic; update docs
- [ ] After merge: remove obsolete required check names once Bugbot proven

### Task 6: Soak + archive

- [ ] Code search: zero callers
- [ ] Spot-check Automations + native settings
- [ ] Archive EdulyCom/github-actions; README retired banner
- [ ] Vault/infra notes; audit Anthropic secrets before deletion
