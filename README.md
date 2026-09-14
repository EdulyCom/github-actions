# github-actions — RETIRED

> **Status (2026-09-14):** This repository is **retired**. Do not add new callers.
>
> Replacement:
> - **PR review / merge gate:** [Cursor Bugbot](https://cursor.com/docs/bugbot) (enable per repo; require the `Cursor Bugbot` check; turn on fail-on-unresolved when available)
> - **Auto-assign + unmerged branch cleanup:** Cursor Automations (drafts in [`docs/superpowers/automations/2026-09-14-retire-github-actions-drafts.md`](docs/superpowers/automations/2026-09-14-retire-github-actions-drafts.md)); interim local workflows ship in consumers until Automations are saved
> - **Issue close + merged branch delete:** GitHub native settings (`delete_branch_on_merge` + auto-close linked issues)
>
> Design: [`docs/superpowers/specs/2026-09-14-retire-github-actions-design.md`](docs/superpowers/specs/2026-09-14-retire-github-actions-design.md)  
> Plan: [`docs/superpowers/plans/2026-09-14-retire-github-actions.md`](docs/superpowers/plans/2026-09-14-retire-github-actions.md)  
> Enable Bugbot script: [`scripts/enable-bugbot-consumers.sh`](scripts/enable-bugbot-consumers.sh) (needs `CURSOR_API_KEY`)
>
> Consumer cutover PRs:
> - https://github.com/EdulyCom/infra-template/pull/404
> - https://github.com/EdulyCom/infra-payload/pull/44
> - https://github.com/aikstudio/aik/pull/53
> - https://github.com/Lagn-App/lagn/pull/250
> - https://github.com/EdulyCom/ezzu/pull/1059
> - https://github.com/EdulyCom/eduly/pull/4659

---

# github-actions (historical)

Shared GitHub Actions for CI-native AI-assisted PR review, post-merge QA,
and PR auto-assignment — packaged as composite actions. Superseded by the
stack above; kept for history until this repo is archived.

## Former actions

- **`ai-review`** — CI-native AI review gate via job output
- **`ai-qa`** — post-merge delivery hygiene
- **`auto-assign`** — assign PR author

See git history and `docs/adr/` for the design that was replaced.
