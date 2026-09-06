# Claude health probe → free SO failover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-run Claude health probe so `ai-review` uses free SO models when Claude OAuth is dead, and automatically returns to Claude when the next probe succeeds after renew.

**Architecture:** Pure `lib/provider-health.js` classifies probe HTTP results and rebinds model IDs; the existing `route` bash step performs a ≤10s `curl` probe, then applies rebinding to `model` / Haiku / fallbacks / `osh-agents.json` before any `claude-code-action` stage.

**Tech Stack:** Node 24+ `node:test`, composite action bash, `curl`, existing OmniRoute Anthropic-compatible `/v1/messages`.

## Global Constraints

- Spec: [`docs/superpowers/specs/2026-09-06-ai-review-claude-health-failover-design.md`](../specs/2026-09-06-ai-review-claude-health-failover-design.md)
- Dead primary: `oc/nemotron-3.5-lightning-free`
- Dead fallbacks: `oc/deepseek-v4-flash-free,auto/best-free`
- Probe model: `claude/claude-sonnet-5`; budget ≤10s
- Unknown (timeout/5xx) → treat as dead + `::warning`
- Context + Review + fan-out agent models all rebind; OSH topology unchanged
- Never log the bearer token; probe must not fail the job
- Gate / Publish / ADR 0004 unchanged
- Injection safety: bind secrets via `env:`, never `${{ secrets }}` inside script bodies beyond existing patterns

## File map

| File | Role |
|---|---|
| Create `ai-review/lib/provider-health.js` | Classify probe result; compute rebound model set; rewrite agents JSON models |
| Create `ai-review/lib/provider-health.test.js` | Unit tests for classification + rebinding |
| Modify `ai-review/action.yml` (`route` step) | curl probe + apply rebinding + emit `ai-review-provider-health` |
| Modify `ai-review/README.md` | One short paragraph on auto failover |

---

### Task 1: `provider-health` helper (TDD)

**Files:**
- Create: `ai-review/lib/provider-health.js`
- Create: `ai-review/lib/provider-health.test.js`

**Interfaces:**
- Produces:
  - `FREE_SO_PRIMARY` = `"oc/nemotron-3.5-lightning-free"`
  - `FREE_SO_FALLBACK` = `"oc/deepseek-v4-flash-free,auto/best-free"`
  - `classifyProbeResult({ statusCode, body, errorKind })` → `{ status: "alive"|"dead"|"unknown", reason: string }`
  - `resolveModelsForHealth({ status, claude })` → `{ model, fallbackModel, haikuModel, haikuFallbackModel, helperModel, useFree }`
    - `claude`: `{ model, fallbackModel, haikuModel, haikuFallbackModel, helperModel }`
  - `rewriteAgentsModels(agentsObj, modelId)` → new object with every top-level agent `.model` set to `modelId`

- [ ] **Step 1: Write failing tests** in `ai-review/lib/provider-health.test.js` covering:
  - 200 → alive
  - 401 + authentication expired body → dead
  - timeout / network errorKind → unknown
  - resolveModelsForHealth dead → free primary/fallbacks for review+haiku+helper
  - resolveModelsForHealth alive → passthrough claude fields
  - rewriteAgentsModels replaces all agent models

- [ ] **Step 2: Run tests — expect FAIL**

```bash
node --test ai-review/lib/provider-health.test.js
```

- [ ] **Step 3: Implement `provider-health.js`**

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit** (only if user requested commits; otherwise leave staged for later)

---

### Task 2: Wire probe into `route` step

**Files:**
- Modify: `ai-review/action.yml` (env on `route` + bash after model constants / before emitting outputs)

**Interfaces:**
- Consumes: Task 1 helpers via `node -e` / small CLI invocation
- Produces: updated `steps.route.outputs.model`, `fallback-model`, `haiku-model`, `haiku-fallback-model`, `osh-agents`

- [ ] **Step 1: Add env to route step**

```yaml
ANTHROPIC_BASE_URL: ${{ inputs.anthropic-base-url }}
ANTHROPIC_AUTH_TOKEN: ${{ inputs.anthropic-auth-token != '' && inputs.anthropic-auth-token || inputs.anthropic-api-key }}
PROVIDER_HEALTH_JS: ${{ github.action_path }}/lib/provider-health.js
```

- [ ] **Step 2: After MODEL/FALLBACK/HAIKU are chosen (and before writing GITHUB_OUTPUT / after OSH_AGENTS copy), run probe**

Logic (bash):
1. If `ANTHROPIC_BASE_URL` or token empty → status unknown, reason missing-config, treat as dead
2. Else `curl -sS -m 10 -o body -w "%{http_code}"` POST `/v1/messages` with probe body
3. Pass status + body to `classifyProbeResult` via node
4. If status is unknown (or dead), print `::warning::...`
5. Call `resolveModelsForHealth`; assign MODEL/FALLBACK/HAIKU/HAIKU_FALLBACK/HELPER_MODEL
6. If `useFree`, rewrite `.ai-review/osh-agents.json` models with HELPER_MODEL / free primary via node + `rewriteAgentsModels`
7. Echo `ai-review-provider-health {json}`

- [ ] **Step 3: Confirm Context/Review/retry already read route outputs** (no further YAML changes if outputs are rebound)

- [ ] **Step 4: Commit** (if requested)

---

### Task 3: README note

**Files:**
- Modify: `ai-review/README.md` (short paragraph near model cascade docs)

- [ ] **Step 1: Document** that a per-run Claude probe promotes free SO when Claude OAuth is dead and restores Claude automatically on the next successful probe.

- [ ] **Step 2: Run full unit suite**

```bash
node --test "ai-review/lib/**/*.test.js"
```

Expected: all PASS

---

## Spec coverage checklist

| Spec § | Task |
|---|---|
| 4.1–4.3 probe + classify | Task 1–2 |
| 4.4 rebind Context/Review/agents | Task 1–2 |
| 4.5 telemetry line | Task 2 |
| 4.6 fail-closed unchanged | no Publish change |
| §6 unit tests | Task 1 |
| README | Task 3 |
