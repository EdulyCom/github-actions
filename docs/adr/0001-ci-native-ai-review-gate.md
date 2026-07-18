# ADR 0001: CI-Native AI Review Gate via Job Output, Not an Identity-Pinned Check

**Status:** Accepted
**Date:** 2026-07-18
**Supersedes:** [`ADR 0017: Central Webhook Server Replaces the Actions Gate`](https://github.com/EdulyCom/ai-tooling/blob/main/docs/adr/0017-central-webhook-server.md)
(EdulyCom/ai-tooling) — the standalone `mtm-bot-server` NestJS webhook
server it describes, and every ADR in its lineage back to the original
Actions-based gate, are retired by this ADR. AI review and AI QA move from
"a durable server that receives GitHub webhooks and republishes an
App-authored Check Run" back onto GitHub Actions itself, but with a
materially different gate mechanism than the original Actions-based design
ever used (see Decision (a)).

## Context

AI-assisted PR review and post-merge QA have, until now, been developer-run
Claude Code skills (`ai-review`, `ai-qa` in the `autopilot` plugin). A
developer or scheduled job invokes the skill locally or in CI, and the skill
posts a marker comment that `mtm-bot-server` — a standalone, always-on
webhook server — reads in order to publish an enforcing Check Run and a
result label. That architecture requires a human (or a separate scheduled
trigger) to invoke the skill, and it requires operating a bespoke server as
a single point of failure for every gated PR across every consuming repo.

This repo, `github-actions`, replaces both pieces at once: AI review and AI
QA run automatically, as ordinary CI jobs, on every PR — no server, no
manual invocation. The gate logic is packaged as composite GitHub Actions
that any repository can consume via a thin caller workflow. The repo is
public and every default is organization-agnostic; EdulyCom is this
project's first consumer, not its subject. Six decisions from that shift
are documented here because they are easy to get wrong a second time, and
because a future adopter reading this repo needs to know not just *what*
was built but *why* the obvious alternative at each fork was rejected.

## Decision

### (a) Gate mechanism: ordinary job output, not an identity-pinned Check Run

The AI review action gates a consumer's heavy CI **via an ordinary
in-workflow job dependency**, not via an App-authored, identity-pinned
required Check Run.

Concretely: the `ai-review` action exposes its verdict as a job output
(`verdict`, alongside `confidence`, `merge_risk`, and `review_event`). A
consumer runs that action as the first job in its own CI workflow, then adds
a small `review-gate` job that `needs: [ai-review]` and fails red unless
`needs.ai-review.outputs.verdict == 'pass'`. Every heavy CI lane (build,
test, deploy-preview, etc.) in turn `needs: [review-gate]`, so a failing or
non-passing verdict skips all downstream compute. Branch protection then
requires the `review-gate` and terminal-CI job statuses — ordinary
`pull_request` job statuses that enter the PR's status rollup exactly like
any other CI job, with no special handling.

This deliberately does **not** reintroduce an identity-pinned enforcing
Check Run (the "quality-gate" pattern from ADR 0014–0017's lineage in
`ai-tooling`), for two structural reasons:

1. A native GitHub PR review (`APPROVE` / `REQUEST_CHANGES` / `COMMENT`)
   cannot itself be configured as a branch protection's *required status
   context* — a `REQUEST_CHANGES` review does not hard-block a merge on its
   own. Building a hard gate on top of a review therefore always requires a
   second, separate signal.
2. The alternative second signal — an App-authored Check Run created via a
   head-SHA `checks.create` API call — needs the App's own token minted
   specifically for that call, and it runs into a known, unresolved GitHub
   platform gap: a `workflow_dispatch`-triggered run's implicit check-suite
   does not reliably attach to the originating PR
   ([actions/checkout#3414](https://github.com/actions/checkout/issues/3414)
   and the family of issues it represents), which is exactly the failure
   mode that made the old design fragile enough to need
   `mtm-bot-server`'s durable-queue-plus-reconciler workaround in the first
   place.

An ordinary `pull_request`-triggered job's status, by contrast, attaches to
the PR's status rollup as a normal side effect of the workflow running on
that event — no App-authored head-SHA check, no `workflow_dispatch`
indirection, no reconciler needed to paper over a delivery gap. This is
strictly simpler, and it removes the single largest source of the
reliability problems ADR 0017 was written to fix, rather than working
around them with more infrastructure.

**Consequence for adopters:** a repository that previously required an old
identity-pinned check (e.g. a `quality-gate` or `ai-review` App check) as a
branch-protection required status context **must remove that required
context** when it wires in this action, and add the new `review-gate` /
terminal-CI job names in its place. Leaving the old context configured as
required will deadlock every PR, because nothing will ever post to it
again. See `docs/consumer-integration.md`.

### (b) Authoring identity is cosmetic, never a gate input

A caller may optionally supply `app-id` + `private-key` for a GitHub App
installation. If supplied, the review comment and the pass/fail label are
authored under that App's own slug (e.g. `mtm-bot[bot]` for EdulyCom). If
omitted, the action falls back to `GITHUB_TOKEN` and authors as
`github-actions[bot]`. The action itself hardcodes no App identity.

This choice affects **only** whose name appears as the author of the review
and the label — nothing else. In particular:

- The `✓ /ai-review` / `✗ /ai-review` (and equivalent QA) labels are
  informational badges for humans scanning a PR list. They are never a CI
  trigger. No workflow in this repo or in `docs/consumer-integration.md`'s
  example callers keys any job off `pull_request: types: [labeled]`.
- Heavy CI gates exclusively on the `ai-review` job's `verdict` output,
  read via `needs:` + `if:` as described in (a) — never on the label event.

This is deliberate, not an oversight: GitHub does not reliably cascade
downstream workflow triggers from `GITHUB_TOKEN`-authored label events, and
even an App-authored label add is a comparatively fragile thing to trigger
CI from (it is a second, independent event delivery, with its own chance to
be dropped or arrive out of order relative to the run it describes). A job
dependency inside a single workflow run has no such delivery step — it is
resolved in-process by the Actions runner — so it is both deterministic and
free of the `#3414`-class attachment gap from (a).

### (c) Composite actions with a thin caller, not reusable workflows

The gate logic is packaged as **composite actions** (`action.yml` bundling
the step sequence), consumed by a **thin per-repo caller workflow** that
owns triggers, permissions, and concurrency. Reusable workflows
(`workflow_call`) were considered and rejected for this role.

The reason is where control over the job graph needs to live. A reusable
workflow is invoked as its own separate workflow run (or, called from a
job, still owns its own `permissions:` and cannot be interleaved as an
arbitrary step inside a caller's existing job). A composite action, by
contrast, is just a step inside whichever job the caller defines — so the
caller's own `ci.yml` can run `ai-review` as literally the first job in its
existing workflow, let a small `review-gate` job `needs:` it directly
alongside the caller's other jobs, and share the caller's own concurrency
group (so a superseding commit cancels the review the same way it cancels
the rest of that PR's CI). None of that composition is possible if the
review logic instead owns a separate `on:` trigger and its own permission
and concurrency scope, which is what a reusable workflow would require.

This also avoids a second trap adjacent to (a): an alternative design where
a standalone `ai-review.yml` reusable workflow gates `ci.yml` via
`workflow_run` was considered and rejected, because a `workflow_run`-invoked
job executes in the *base* branch's context, not the PR's, and its status
does not attach to the PR rollup as cleanly as an ordinary `pull_request`
job — a different flavor of the same attachment problem (a) exists to
avoid.

The trade-off this accepts: each consuming repo must copy and maintain a
small (roughly 20–40 line) caller workflow, rather than pointing a single
`uses:` at a reusable workflow with a few inputs. `docs/consumer-integration.md`
exists specifically to make that copy step mechanical.

### (d) Parameterization surface

What is a caller-supplied input versus a repo-agnostic default follows one
rule: **nothing organization-specific ships as a default.** Concretely:

- **Caller-supplied, no default (required or org-specific when used):**
  `app-id` / `private-key` (optional pair, for (b)'s App-authored identity),
  an Anthropic credential (`anthropic-api-key` or `anthropic-auth-token`),
  and — for `ai-qa` — `health-url` / `test-command`, which are inherently
  per-repo.
- **Caller-supplied, generic fallback default:** `confidence-threshold`
  (defaults to 90), `runner-label` (defaults to `ubuntu-latest`; realized as
  a job-level `runs-on:` expression in the caller's own workflow, not an
  action `with:` input, since a composite action cannot set its own job's
  `runs-on:`), the pass/fail label text, `anthropic-base-url` (omitted → the standard
  Anthropic API endpoint), model IDs (generic defaults, repo-variable
  overridable for gateway aliasing), `github-token` (defaults to
  `${{ github.token }}`), and `ai-qa`'s deploy timeout.
- **Not parameterized at all — hardcoded, repo-agnostic behavior:** the gate
  mechanism itself (the job-output contract from (a)), the
  label-is-a-badge-never-a-trigger rule from (b), the injection-safety rule
  that every attacker-influenceable value reaches a shell only through a
  step-level `env:` binding (never inlined into a `run:` block), and the
  verdict computation itself. These are correctness and security properties
  of the action, not configuration a caller should be able to weaken.

### (e) Public, path-referenced, license deferred

This repo is public and every default is organization-agnostic (no action
ships an EdulyCom-specific default — EdulyCom's own values live only in
EdulyCom's caller workflows, never in this repo). Consumers reference
actions by path — `EdulyCom/github-actions/<action>@main` — rather than
through a GitHub Marketplace listing; Marketplace publication is a
documented future option, not part of this scaffold. First-party composite
actions in this repo stay on a floating `@main` reference rather than
semver tags, offset by `CODEOWNERS`-guarded review of every change to this
repo (see (f) for why that trade-off does not apply to third-party
dependencies).

The repo currently ships without a `LICENSE` file. Under GitHub's default,
a public repository with no license grants no reuse rights beyond viewing
the source — effectively "all rights reserved." This is a deliberate,
scoped decision: it blocks *external* reuse until a license is chosen, but
it does not affect EdulyCom's own internal consumption, since EdulyCom
already holds owner/organization rights to a repo it publishes. Choosing a
license is left as a future, separate decision; `README.md` carries the
same note for anyone landing on the repo directly.

### (f) Supply-chain and least-privilege posture

Two different pinning policies apply to two different kinds of `uses:`
references in this repo, and the difference is intentional:

- **Third-party actions** — everything not under the `EdulyCom` org, both
  inside composite actions built later in this project and in this repo's
  own self-CI (this task's `actionlint.yml` and `zizmor.yml`, and later
  `anthropics/claude-code-action`, `actions/github-script`,
  `actions/create-github-app-token`, `actions/checkout`) are pinned to a
  **full 40-character commit SHA**, with a trailing `# vX.Y.Z` comment
  recording the human-readable release that SHA corresponds to. A
  `.github/dependabot.yml` (`package-ecosystem: github-actions`, weekly)
  opens bump PRs against those pins automatically. This follows GitHub's
  own hardening guidance for third-party action consumption, and it matters
  doubly here because this is a public repo other organizations may copy
  verbatim — a floating tag on a third-party dependency is a supply-chain
  risk this project should not hand downstream by example.
- **First-party composite actions** in this repo are the opposite:
  they stay on floating `@main` (D8 in the project plan), because the
  guarantee that matters for a same-repo dependency is "every change to
  `@main` went through `CODEOWNERS`-gated review," not "this exact commit
  was audited once and never moves." Pinning first-party actions to a SHA
  would just make every routine internal change a two-PR dance with no
  corresponding security benefit.

Beyond pinning, the actions built in this project (in later tasks) follow a
least-privilege posture that this ADR records so later work is held to it:
an App token, when used, is minted with per-permission scope (only the
specific permissions a job needs — e.g. `pull-requests: write` plus
`issues: write` for labels — never the installation's full permission set)
and minted inside the same job that uses it, so it cannot cross job
boundaries and is discarded when that job's runner is torn down; the
head-SHA `actions/checkout` step in the review job sets
`persist-credentials: false`; every Claude-invoking job sets
`timeout-minutes` as a runaway-cost guard; and thin caller workflows keep
workflow-level `permissions:` scoped to `contents: read` /
`pull-requests: write` rather than defaulting to broader access.

This repo's own `actionlint.yml` and `zizmor.yml` (added in this task) are
part of the same posture: they run on every PR to this repo and catch
exactly the classes of mistake this section describes — over-broad
permissions, unpinned third-party actions, and injection-prone `run:`
blocks — automatically, rather than relying on review alone.

## Consequences

- Adopting this gate in a repo that previously used an identity-pinned
  check requires a coordinated cutover: add the new caller workflow and the
  new required contexts (`review-gate` and the relevant terminal CI job)
  to branch protection *before* removing the old required context, to avoid
  a window where neither gate is enforced; then remove the old context once
  the new one is confirmed posting. See `docs/consumer-integration.md`.
- `mtm-bot-server` and its durable-queue/reconciler design (ADR 0017) are no
  longer needed once every consumer has cut over, since the delivery-loss
  problem it solved does not exist for an ordinary `pull_request` job
  status. Retiring that server is tracked as separate follow-on work, not
  part of this repo.
- Because labels are never a CI trigger, a consumer cannot build additional
  automation on `pull_request: labeled` for these labels without
  re-litigating (b) — any such automation would reintroduce exactly the
  fragile-trigger problem this ADR avoids.
- Third-party action pins in this repo require ongoing maintenance via the
  Dependabot bump PRs this task adds; those PRs should be reviewed for the
  release notes they correspond to, not merged blindly, since a SHA pin's
  entire value is that the maintainer — not an automated merge — decides
  when the pin moves.
