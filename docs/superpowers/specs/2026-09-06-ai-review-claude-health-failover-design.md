# `ai-review` Claude health probe → free SO failover — design

**Status:** Approved in design session 2026-09-06; awaiting implementation.
**Extends:** CI-native review gate ([`docs/adr/0001-ci-native-ai-review-gate.md`](../../adr/0001-ci-native-ai-review-gate.md)),
structured-output repair ([`docs/adr/0004-non-blocking-findings-and-structured-output-repair.md`](../../adr/0004-non-blocking-findings-and-structured-output-repair.md)),
and the locked model cascades in [`ai-review/action.yml`](../../../ai-review/action.yml).
**Authors:** synthesized from the 2026-09-06 Lagn / OmniRoute outage debug session.

---

## 1. Purpose

When the gateway’s **Claude provider OAuth is expired** (or otherwise unable to
complete), Claude Code’s `--fallback-model` does **not** promote free models:
OmniRoute returns a fast `401 authentication_error`, the CLI keeps retrying
`claude/…` until `API_TIMEOUT_MS`, and Publish fails closed as inconclusive.

This design adds a **per-run Claude health probe** so:

1. **Claude dead** → Context + Review use free structured-output (`oc/…`) primaries.
2. **Claude renewed** → the next job’s probe succeeds and Claude is primary again
   with no manual toggle, secret change, or OmniRoute config edit.

The gate contract (`verdict` pass/fail, fail-closed on missing structured output)
is unchanged.

---

## 2. Evidence that motivated the design

| Observation | Implication |
|---|---|
| OmniRoute logs `claude \| … none active` / `authentication expired` while GHA still posts `/v1/messages` | Traffic reaches the gateway; upstream Claude OAuth is the fault |
| Probe `POST /v1/messages` with model `claude/claude-sonnet-5` → **HTTP 401 in ~50ms** when expired | Health can be decided without waiting for `API_TIMEOUT_MS` |
| `oc/nemotron-3.5-lightning-free` → **HTTP 200** with OpenCode active | Free SO primary is viable while Claude is down |
| `oc/deepseek-v4-flash-free` may return provider unavailable | Keep as fallback, not sole primary |
| Action comments: `--fallback-model` fires on overload responses, not auth-expiry hangs | Must not rely on Claude Code fallback for this failure mode |

---

## 3. Locked product decisions

| Decision | Choice |
|---|---|
| Where failover lives | Inside `ai-review` (not OmniRoute provider fallthrough) |
| Detection | One short authenticated `POST /v1/messages` health probe per job |
| Probe model | `claude/claude-sonnet-5` (same provider family as Review primary) |
| On Claude **alive** | Unchanged cascade: Claude primary; free SO as `--fallback-model` |
| On Claude **dead** | Free SO primary for **both** Context and Review (do not skip Context) |
| Dead primary | `oc/nemotron-3.5-lightning-free` |
| Dead fallbacks | `oc/deepseek-v4-flash-free,auto/best-free` |
| On probe **unknown** (timeout / 5xx / network) | Treat as **dead** for this run (prefer a free attempt over a 180s hang); warn loudly |
| Auto-return to Claude | Implicit: next run’s probe succeeds after OAuth reconnect |
| Gate / Publish / repair | Unchanged (ADR 0004 still applies) |
| Caller inputs | No new required inputs; uses existing `anthropic-base-url` + auth token |

---

## 4. Behavior

### 4.1 When the probe runs

After author/token resolution and PR guards that still allow the review path, and
in the same deterministic prep/routing step that already emits `model` /
`fallback-model` / `haiku-model` outputs (or a dedicated step immediately before
Context that **overrides** those outputs). Must run **before** any
`claude-code-action` Context or Review invocation.

Skip the probe (and leave models unchanged) when the job already skips model
stages (fork / draft / closed), matching existing `if:` guards.

### 4.2 Probe request

- Method/URL: `POST {anthropic-base-url}/v1/messages`
- Auth: same credential the stages use (`Authorization: Bearer …` from
  `anthropic-auth-token`, or the key material already passed as
  `anthropic_api_key` when that is how the caller authenticates)
- Body: `{"model":"claude/claude-sonnet-5","max_tokens":1,"messages":[{"role":"user","content":"ping"}]}`
- Headers: `content-type: application/json`, `anthropic-version: 2023-06-01`
- Wall-clock budget: **≤ 10 seconds** (far below `api-timeout-ms`)

Do not log the bearer token. Do not fail the job on probe failure — only rebind models.

### 4.3 Classification

| Probe outcome | `provider_health` | Model binding |
|---|---|---|
| HTTP 2xx | `alive` | Claude primary (current SONNET/OPUS/HAIKU routing) |
| HTTP 401, or body/type mentioning `authentication_error` / `authentication expired` / `none active` / `invalid_api_key` with Claude auth message | `dead` | Free SO primary for Review + Context |
| Timeout, connection error, HTTP 5xx, other unexpected | `unknown` → treat as `dead` | Same as `dead`, plus `::warning` |

### 4.4 Model rebinding when `dead` / `unknown`

| Output | Alive (today) | Dead |
|---|---|---|
| Review `--model` | routed Claude (Sonnet/Opus per OSH) | `oc/nemotron-3.5-lightning-free` |
| Review `--fallback-model` | free SO list | `oc/deepseek-v4-flash-free,auto/best-free` |
| Context `--model` (Haiku) | Haiku | `oc/nemotron-3.5-lightning-free` |
| Context `--fallback-model` | composer + free | `oc/deepseek-v4-flash-free,auto/best-free` |
| Fan-out `--agents` worker models | Claude Sonnet helpers | Same free SO primary (workers must not target dead Claude) |

OSH topology (`collapse` vs `fanout`) is **unchanged** by health; only model IDs
rebind. Fan-out on free models may be slower or weaker — acceptable for outage
continuity; quality is best-effort until Claude returns.

### 4.5 Telemetry

Emit one scrapable line per run (success or fail of the probe):

```text
ai-review-provider-health {"status":"alive|dead|unknown","primary":"<model>","reason":"<short>","probe_ms":N}
```

Existing Publish footer that names the model used remains the human-facing
signal of which stack ran.

### 4.6 Failure modes that remain fail-closed

If free SO also cannot produce schema-valid structured output, Publish still
posts inconclusive and `verdict=fail` (ADR 0004). Failover only removes the
Claude-auth hang; it does not invent a pass.

---

## 5. Non-goals

- Changing OmniRoute connection storage or performing OAuth reconnect from CI
- Making Claude Code `--fallback-model` the sole mechanism for auth expiry
- Adding a caller “force free models” input (probe is automatic)
- Softening the Lagn (or other consumer) `verdict == pass` gate
- Guaranteeing free-model review quality equal to Claude

---

## 6. Testing

| Case | Expectation |
|---|---|
| Unit: classify 401 auth body → `dead` | Rebind to free primary |
| Unit: classify 200 → `alive` | Claude primary unchanged |
| Unit: classify timeout → `unknown`/`dead` | Free primary + warning |
| Unit/integration: route outputs when dead include Context + Review + agents | No `claude/` left as primary when dead |
| Manual / soak: renew Claude OAuth, re-run job | Probe `alive`, Claude primary again |

Prefer a small pure helper (e.g. `lib/provider-health.js`) required from the
routing step so classification is unit-tested without paying for a live gateway.

---

## 7. Rollout

1. Land helper + action.yml wiring on `EdulyCom/github-actions` `@main` (or a
   short-lived PR reviewed and merged).
2. Consumers on `@main` (e.g. Lagn) pick it up on next workflow run — no Lagn
   workflow change required.
3. While Claude remains expired, confirm Actions logs show
   `ai-review-provider-health {"status":"dead",…}` and Review cost/`structured_output`
   from a free model.
4. After Claude reconnect, confirm `status":"alive"` and Claude primary without
   reverting this change.

---

## 8. Open follow-ups (not blocking)

- Clearer Publish inconclusive reason when `duration≈timeout && cost==0 && turns≤1`
  (still useful if free models also hang).
- Optional shorter Context skip when `dead` **and** collapse route — deferred;
  this design keeps Context on free SO.
