# Cursor Automations drafts (retire github-actions)

Create these in the **Agents Window** Automations editor (`open_automation` handoff).
Scope: all six consumers listed in the design doc.

## 1. Auto-assign PR author

| Field | Value |
|--------|--------|
| Name | PR auto-assign author |
| Description | Assign the PR author when a human opens or marks a PR ready; skip bots and already-assigned PRs |
| Trigger | GitHub: pull request opened; pull request ready for review |
| Repo scope | EdulyCom/eduly, EdulyCom/ezzu, EdulyCom/infra-template, EdulyCom/infra-payload, Lagn-App/lagn, aikstudio/aik |
| Tools | Agent shell / GitHub write as available |

**Instructions:**

```
When this automation runs on a pull request:

1. Resolve the PR number and author login from the event.
2. If the author login ends with "[bot]", do nothing and exit.
3. If the PR already has one or more assignees, do nothing and exit.
4. Otherwise assign the PR author as the sole assignee using gh or the GitHub API.
5. Do not comment on the PR unless assignment fails; then leave a short failure note.
```

## 2. Delete head branch on close-without-merge

| Field | Value |
|--------|--------|
| Name | PR cleanup unmerged head branch |
| Description | When a PR is closed without merging, delete the head branch if it is safe to do so |
| Trigger | GitHub: pull request closed |
| Repo scope | same six repos |
| Tools | Agent shell / GitHub write as available |

**Instructions:**

```
When a pull request is closed:

1. If the PR was merged, exit immediately (GitHub auto-delete handles merged heads).
2. If the head repo differs from the base repo (fork), exit.
3. Resolve the default branch name; if head ref equals the default branch, exit.
4. Check whether any other open PR in this repo uses the same head ref; if yes, exit.
5. Delete the head ref (gh api DELETE repos/{owner}/{repo}/git/refs/heads/{branch}).
6. On 403/404/422, log the error and stop; do not retry in a loop.
```

## Interim note

Until these Automations are saved in the editor, consumers ship equivalent thin workflows
`.github/workflows/pr-auto-assign.yml` and `.github/workflows/pr-cleanup-unmerged-branch.yml`
that do not depend on EdulyCom/github-actions. Remove those workflows after Automations are live.
