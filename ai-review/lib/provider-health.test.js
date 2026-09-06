"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  FREE_SO_PRIMARY,
  FREE_SO_FALLBACK,
  classifyProbeResult,
  resolveModelsForHealth,
  rewriteAgentsModels,
} = require("./provider-health.js");

test("classifyProbeResult: HTTP 2xx → alive", () => {
  const out = classifyProbeResult({ statusCode: 200, body: "{}" });
  assert.equal(out.status, "alive");
  assert.match(out.reason, /ok|2xx|success/i);
});

test("classifyProbeResult: HTTP 401 with authentication expired → dead", () => {
  const body = JSON.stringify({
    error: {
      message:
        "[claude] All 1 connection(s) authentication expired — please reconnect in the dashboard",
      type: "authentication_error",
      code: "invalid_api_key",
    },
  });
  const out = classifyProbeResult({ statusCode: 401, body });
  assert.equal(out.status, "dead");
  assert.match(out.reason, /auth|expired|401/i);
});

test("classifyProbeResult: HTTP 401 without body still dead", () => {
  const out = classifyProbeResult({ statusCode: 401, body: "" });
  assert.equal(out.status, "dead");
});

test("classifyProbeResult: timeout → unknown", () => {
  const out = classifyProbeResult({
    statusCode: 0,
    body: "",
    errorKind: "timeout",
  });
  assert.equal(out.status, "unknown");
  assert.match(out.reason, /timeout/i);
});

test("classifyProbeResult: network error → unknown", () => {
  const out = classifyProbeResult({
    statusCode: 0,
    body: "",
    errorKind: "network",
  });
  assert.equal(out.status, "unknown");
});

test("classifyProbeResult: HTTP 503 → unknown", () => {
  const out = classifyProbeResult({ statusCode: 503, body: "unavailable" });
  assert.equal(out.status, "unknown");
});

test("resolveModelsForHealth: alive passthrough", () => {
  const claude = {
    model: "claude/claude-sonnet-5",
    fallbackModel: "oc/a,oc/b",
    haikuModel: "claude/claude-haiku-4-5-20251001",
    haikuFallbackModel: "claude/cursor/composer-2.5,oc/a",
    helperModel: "claude/claude-sonnet-5",
  };
  const out = resolveModelsForHealth({ status: "alive", claude });
  assert.equal(out.useFree, false);
  assert.equal(out.model, claude.model);
  assert.equal(out.fallbackModel, claude.fallbackModel);
  assert.equal(out.haikuModel, claude.haikuModel);
  assert.equal(out.haikuFallbackModel, claude.haikuFallbackModel);
  assert.equal(out.helperModel, claude.helperModel);
});

test("resolveModelsForHealth: dead → free primary for review+context+helper", () => {
  const claude = {
    model: "claude/claude-opus-5",
    fallbackModel: "oc/x,oc/y",
    haikuModel: "claude/claude-haiku-4-5-20251001",
    haikuFallbackModel: "claude/cursor/composer-2.5,oc/x",
    helperModel: "claude/claude-sonnet-5",
  };
  const out = resolveModelsForHealth({ status: "dead", claude });
  assert.equal(out.useFree, true);
  assert.equal(out.model, FREE_SO_PRIMARY);
  assert.equal(out.fallbackModel, FREE_SO_FALLBACK);
  assert.equal(out.haikuModel, FREE_SO_PRIMARY);
  assert.equal(out.haikuFallbackModel, FREE_SO_FALLBACK);
  assert.equal(out.helperModel, FREE_SO_PRIMARY);
});

test("resolveModelsForHealth: unknown treated like dead", () => {
  const claude = {
    model: "claude/claude-sonnet-5",
    fallbackModel: "a,b",
    haikuModel: "h",
    haikuFallbackModel: "hf",
    helperModel: "help",
  };
  const out = resolveModelsForHealth({ status: "unknown", claude });
  assert.equal(out.useFree, true);
  assert.equal(out.model, FREE_SO_PRIMARY);
});

test("rewriteAgentsModels replaces every agent model", () => {
  const agents = {
    "osh-coverage": { model: "claude/claude-sonnet-5", tools: ["Read"] },
    "osh-tracer": { model: "claude/claude-sonnet-5", prompt: "x" },
  };
  const out = rewriteAgentsModels(agents, FREE_SO_PRIMARY);
  assert.equal(out["osh-coverage"].model, FREE_SO_PRIMARY);
  assert.equal(out["osh-tracer"].model, FREE_SO_PRIMARY);
  assert.deepEqual(out["osh-coverage"].tools, ["Read"]);
  // input not mutated
  assert.equal(agents["osh-coverage"].model, "claude/claude-sonnet-5");
});
