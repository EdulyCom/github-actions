# github-actions

Shared GitHub Actions for CI-native AI-assisted PR review, post-merge QA,
and PR auto-assignment — packaged as composite actions any organization can
consume from a thin caller workflow in its own repos.

This repo is being built out to provide three composite actions, landing
across the tasks tracked in `docs/plan.md`:

- **`ai-review`** — runs an AI code review against a PR's diff and exposes a
  `verdict` job output (plus `confidence`, `merge_risk`, and a review
  comment) that a consumer's own CI uses as an ordinary job dependency to
  gate heavier build/test/deploy lanes. It optionally authors the review and
  a pass/fail label under a GitHub App's identity if the caller supplies
  App credentials; otherwise it falls back to `github-actions[bot]`. Either
  way, the label is a badge for humans — CI gates on the `verdict` output,
  never on the label. See `docs/adr/0001-ci-native-ai-review-gate.md` for
  why this shape was chosen over an identity-pinned Check Run.
- **`ai-qa`** — runs a post-merge, non-blocking QA pass against a deployed
  environment (health check + smoke test) and reports its result as a
  signal, not a merge gate.
- **`auto-assign`** — assigns a PR's author as its assignee when the PR is
  opened or marked ready for review.

## Who is this for

Any organization or repository. Every action's defaults are
organization-agnostic — nothing in this repo hardcodes a specific org, App,
model provider, or environment. `EdulyCom` is this project's first
consumer, wired up through its own repos' caller workflows, but it is an
example, not a dependency of this repo. See `docs/consumer-integration.md`
for what a new consumer needs to configure and which caller workflows to
copy.

## How to consume this

Reference an action by path from your own workflow, e.g.:

```yaml
- uses: EdulyCom/github-actions/ai-review@main
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

First-party actions in this repo are consumed via a floating `@main`
reference, guarded by `CODEOWNERS`-reviewed changes to this repo rather than
pinned release tags — see `docs/adr/0001-ci-native-ai-review-gate.md` for
why that trade-off is intentional here (and why every *third-party* action
this repo itself depends on is instead pinned to a full commit SHA).

Start with `docs/consumer-integration.md` for the secrets/variables to set
and the caller workflows to copy into a consuming repo.

## License

This repository is public, but no `LICENSE` file has been added yet — that
decision is deliberately deferred. Under GitHub's default terms, a public
repo without a license file grants no reuse rights beyond viewing the
source; external reuse of the actions in this repo cannot begin until a
license is chosen. This does not affect EdulyCom's own internal use of this
repository, since EdulyCom already holds the necessary rights as the
repository's owning organization.

## Further reading

- [`docs/consumer-integration.md`](docs/consumer-integration.md) — practical
  setup guide for a consuming repository: required secrets/variables and the
  caller workflows to copy.
- [`docs/adr/0001-ci-native-ai-review-gate.md`](docs/adr/0001-ci-native-ai-review-gate.md)
  — the architectural decisions behind the gate mechanism, the authoring
  identity model, the composite-actions-vs-reusable-workflow choice, the
  parameterization surface, the public/generalized posture, and the
  supply-chain and least-privilege posture this repo follows.
- [`docs/plan.md`](docs/plan.md) — the full build-out plan this repo is
  being implemented against, including the phase/task breakdown and the
  locked design decisions behind it.
