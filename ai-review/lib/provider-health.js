"use strict";

/** Free structured-output primary when Claude provider OAuth is dead. */
const FREE_SO_PRIMARY = "oc/nemotron-3.5-lightning-free";

/** Remaining free SO cascade (Claude Code caps --fallback-model at 3 entries). */
const FREE_SO_FALLBACK = "oc/deepseek-v4-flash-free,auto/best-free";

const AUTH_DEAD_RE =
  /authentication[_ ]?expired|authentication_error|none active|invalid_api_key|please reconnect/i;

/**
 * Classify a Claude health-probe HTTP result.
 *
 * @param {{
 *   statusCode?: number|string|null,
 *   body?: string|null,
 *   errorKind?: string|null,
 * }} args
 * @returns {{ status: 'alive'|'dead'|'unknown', reason: string }}
 */
function classifyProbeResult({ statusCode, body, errorKind } = {}) {
  const kind = String(errorKind || "").toLowerCase();
  if (kind === "timeout") {
    return { status: "unknown", reason: "timeout" };
  }
  if (kind === "network" || kind === "missing-config") {
    return { status: "unknown", reason: kind };
  }

  const code = Number(statusCode);
  const text = String(body || "");

  if (Number.isFinite(code) && code >= 200 && code < 300) {
    return { status: "alive", reason: "http-2xx" };
  }

  if (code === 401 || AUTH_DEAD_RE.test(text)) {
    return { status: "dead", reason: code === 401 ? "http-401-auth" : "auth-message" };
  }

  if (!Number.isFinite(code) || code <= 0) {
    return { status: "unknown", reason: kind || "no-status" };
  }

  if (code >= 500) {
    return { status: "unknown", reason: `http-${code}` };
  }

  // Other 4xx: not a clear Claude-OAuth death signal — still unknown so we
  // fail over rather than risk a 180s CLI hang on a broken primary.
  return { status: "unknown", reason: `http-${code}` };
}

/**
 * Rebind review/context/helper model IDs from probe status.
 *
 * `unknown` is treated like `dead` (prefer free attempt over Claude hang).
 *
 * @param {{
 *   status: 'alive'|'dead'|'unknown',
 *   claude: {
 *     model: string,
 *     fallbackModel: string,
 *     haikuModel: string,
 *     haikuFallbackModel: string,
 *     helperModel: string,
 *   },
 * }} args
 */
function resolveModelsForHealth({ status, claude }) {
  if (status === "alive") {
    return {
      useFree: false,
      model: claude.model,
      fallbackModel: claude.fallbackModel,
      haikuModel: claude.haikuModel,
      haikuFallbackModel: claude.haikuFallbackModel,
      helperModel: claude.helperModel,
    };
  }
  return {
    useFree: true,
    model: FREE_SO_PRIMARY,
    fallbackModel: FREE_SO_FALLBACK,
    haikuModel: FREE_SO_PRIMARY,
    haikuFallbackModel: FREE_SO_FALLBACK,
    helperModel: FREE_SO_PRIMARY,
  };
}

/**
 * Return a shallow-copied agents map with every agent `.model` set to modelId.
 *
 * @param {Record<string, object>} agentsObj
 * @param {string} modelId
 */
function rewriteAgentsModels(agentsObj, modelId) {
  const out = {};
  for (const [name, def] of Object.entries(agentsObj || {})) {
    out[name] = { ...(def || {}), model: modelId };
  }
  return out;
}

module.exports = {
  FREE_SO_PRIMARY,
  FREE_SO_FALLBACK,
  classifyProbeResult,
  resolveModelsForHealth,
  rewriteAgentsModels,
};

// CLI for action.yml (must not use column-0 bash heredocs inside `run: |` —
// they terminate the YAML block). Env-driven; never prints secrets.
if (require.main === module) {
  const fs = require("fs");
  const cmd = process.argv[2] || "";

  if (cmd === "classify") {
    let body = "";
    const bodyFile = process.env.BODY_FILE || "";
    try {
      if (bodyFile && fs.existsSync(bodyFile)) body = fs.readFileSync(bodyFile, "utf8");
    } catch {
      /* ignore */
    }
    process.stdout.write(
      JSON.stringify(
        classifyProbeResult({
          statusCode: process.env.STATUS_CODE,
          body,
          errorKind: process.env.ERROR_KIND || undefined,
        })
      )
    );
    process.exit(0);
  }

  if (cmd === "resolve") {
    process.stdout.write(
      JSON.stringify(
        resolveModelsForHealth({
          status: process.env.HEALTH_STATUS,
          claude: {
            model: process.env.MODEL,
            fallbackModel: process.env.FALLBACK,
            haikuModel: process.env.HAIKU,
            haikuFallbackModel: process.env.HAIKU_FALLBACK,
            helperModel: process.env.HELPER_MODEL,
          },
        })
      )
    );
    process.exit(0);
  }

  if (cmd === "rewrite-agents") {
    const path = process.argv[3];
    if (!path) {
      console.error("usage: provider-health.js rewrite-agents <agents.json>");
      process.exit(2);
    }
    const modelId = process.env.HELPER_MODEL || FREE_SO_PRIMARY;
    const agents = JSON.parse(fs.readFileSync(path, "utf8"));
    fs.writeFileSync(path, JSON.stringify(rewriteAgentsModels(agents, modelId)));
    process.exit(0);
  }

  console.error("usage: provider-health.js classify|resolve|rewrite-agents");
  process.exit(2);
}
