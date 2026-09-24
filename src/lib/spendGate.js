/**
 * 9router half of the distributed Heron spend gate.
 *
 * Governor owns policy (the quota file); 9router enforces per request at the
 * choke point, before any provider is contacted and before any fallback logic
 * runs. OpenRouter per-key limits remain the hard backstop.
 *
 * Contract (mirrors governor/SPEND_GATE.md):
 *  - Quota state file: JSON with per-consumer entries:
 *      { "consumers": { "<consumer>": {
 *          "daily_cap_usd": 1.0,
 *          "spent_today_usd": 0.23,
 *          "per_turn_token_ceiling": 8000,   // informational here; enforced by governor's /permit
 *          "tier_order": ["free", "paid"],
 *          "max_price": { "prompt": 0.05, "completion": 0.40 }  // per-MTok USD
 *      } } }
 *    Path: $GOVERNOR_QUOTA_FILE, else $GOVERNOR_STATE_DIR/spend/quota.json,
 *    else ~/.local/share/opencode/governor/spend/quota.json.
 *  - Absent/unreadable/invalid quota file -> DENY (fail closed).
 *  - Consumer listed and spent_today_usd >= daily_cap_usd -> DENY.
 *  - Consumer not listed -> ALLOW (governor claims jurisdiction by listing;
 *    this preserves existing behavior for unmanaged traffic).
 *  - Denial is terminal: error code "budget_exhausted", HTTP 402, never
 *    retried, never falls back to another provider/model.
 *  - Listed consumer with no approved daily_cap_usd -> DENY (fail closed;
 *    budget values need the owner's word; "consumer_budget_unset").
 *  - Consumers with attested:true must carry a valid X-Heron-Consumer-
 *    Attestation HMAC from the trusted task proxy; missing/invalid -> DENY
 *    ("consumer_attestation_failed"). No shared secret configured -> DENY
 *    ("consumer_attestation_unverifiable"). Unattested consumers keep the
 *    legacy behavior.
 *  - Consumer allowed_models (when present) is authoritative: any other
 *    model -> DENY ("model_not_permitted"). Free-only consumers
 *    (paid_tier_allowed:false or tier_order without "paid") refuse paid
 *    models terminally ("paid_tier_not_permitted"); their tier resolves to
 *    "free" so provider.max_price 0/0 is injected.
 *  - Allowed managed requests get provider.max_price injected on outbound
 *    OpenRouter requests (free tier -> 0/0).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { isFreeModelId } from "open-sse/config/freeModels.js";

export const BUDGET_EXHAUSTED_CODE = "budget_exhausted";

/** Phase-1 automatic task-execution consumer (governor-registered). */
export const HARNESS_CONSUMER = "heron-harness-opencode";

/** HMAC attestation header the trusted task proxy signs per request. */
export const CONSUMER_ATTESTATION_HEADER = "x-heron-consumer-attestation";
export const CONSUMER_ATTESTATION_VERSION = "v1";

/** Env var holding the proxy/9router shared HMAC secret. Never logged. */
export const PROXY_HMAC_SECRET_ENV = "HERON_PROXY_HMAC_SECRET";

/** Max attestation age, in seconds, either side of now. */
export const ATTESTATION_MAX_SKEW_S = 600;

/** Conservative paid-tier ceiling (deepseek-v4-flash sticker) when the quota
 *  file has no explicit max_price for the consumer. Per-MTok USD. */
export const DEFAULT_PAID_MAX_PRICE = { prompt: 0.05, completion: 0.4 };

/** Free tier: only $0 providers may serve. */
export const FREE_MAX_PRICE = { prompt: 0, completion: 0 };

export function governorQuotaFilePath() {
  if (process.env.GOVERNOR_QUOTA_FILE) return process.env.GOVERNOR_QUOTA_FILE;
  const stateDir =
    process.env.GOVERNOR_STATE_DIR ||
    path.join(os.homedir(), ".local/share/opencode/governor");
  return path.join(stateDir, "spend/quota.json");
}

export function readQuotaState() {
  const file = governorQuotaFilePath();
  try {
    const raw = fs.readFileSync(file, "utf8");
    const state = JSON.parse(raw);
    if (!state || typeof state !== "object" || !state.consumers || typeof state.consumers !== "object") {
      return { ok: false, file, reason: "quota_state_invalid" };
    }
    return { ok: true, file, state };
  } catch (e) {
    const reason = e && e.code === "ENOENT" ? "quota_state_missing" : "quota_state_unreadable";
    return { ok: false, file, reason };
  }
}

/**
 * Resolve an explicit consumer claim from Heron correlation values. Work IDs
 * are provenance, not billing identities. The claim must name a registered
 * consumer for Heron-controlled traffic; generic unmanaged traffic keeps the
 * legacy "default" bucket.
 */
export function resolveConsumer(heron) {
  const v = (heron && (heron.values || heron)) || {};
  const explicit = v.consumer;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim().slice(0, 128);
  const controlled = ["trace_id", "intent_id", "work_id", "world_id"].some((key) =>
    typeof v[key] === "string" && v[key].trim()
  );
  return controlled ? null : "default";
}

function hasHeronCorrelation(heron) {
  const v = (heron && (heron.values || heron)) || {};
  return ["trace_id", "intent_id", "work_id", "world_id", "consumer"].some((key) =>
    typeof v[key] === "string" && v[key].trim()
  );
}

function deny(consumer, reason, message) {
  return { decision: "deny", consumer, reason, message, tier: null, maxPrice: null };
}

function allow(consumer, { unmanaged = false, entry = null } = {}) {
  return {
    decision: "allow",
    consumer,
    reason: unmanaged ? "consumer_unmanaged" : "budget_available",
    message: null,
    tier: null,
    maxPrice: null,
    unmanaged,
    entry,
    tokenCeiling:
      entry && Number.isFinite(Number(entry.per_turn_token_ceiling))
        ? Number(entry.per_turn_token_ceiling)
        : null,
  };
}

/**
 * True when the consumer's quota entry forbids paid tiers (Phase-1 free-only
 * policy): explicit flag, or a tier_order that omits "paid".
 */
export function isFreeOnlyConsumer(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.paid_tier_allowed === false) return true;
  if (Array.isArray(entry.tier_order)) return !entry.tier_order.includes("paid");
  return false;
}

/**
 * Per-consumer model allowlist. When the quota entry carries allowed_models,
 * only those exact model ids are permitted; anything else is refused rather
 * than substituted. Absent list (or unknown model) -> no judgment here.
 */
export function consumerAllowsModel(entry, model) {
  const list = entry && Array.isArray(entry.allowed_models) ? entry.allowed_models : null;
  if (!list) return true;
  if (typeof model !== "string" || !model.trim()) return true;
  const want = model.trim();
  return list.some((m) => typeof m === "string" && m.trim() === want);
}

function attestationMessage({ consumer, traceId, workId, ts }) {
  return [CONSUMER_ATTESTATION_VERSION, consumer, traceId || "", workId || "", String(ts)].join("\n");
}

/**
 * Verify a trusted-task-proxy attestation for a consumer claim.
 *
 * Wire format: "v1,<unix_ts>,<hex_hmac_sha256>" where the HMAC (keyed by the
 * shared proxy secret) covers "v1\\n<consumer>\\n<trace_id>\\n<work_id>\\n<ts>".
 * This binds the consumer identity to the task/proxy path: a bare
 * x-heron-consumer header without a valid attestation is rejected.
 *
 * Pure; the secret is passed in so tests never need process env.
 *
 * @returns {{ok:true}|{ok:false, reason:string}} reason is one of
 *   secret_unconfigured | attestation_missing | attestation_malformed |
 *   attestation_expired | attestation_mismatch
 */
export function verifyConsumerAttestation({ consumer, traceId = "", workId = "", attestation = null, secret = null } = {}) {
  if (!secret) return { ok: false, reason: "secret_unconfigured" };
  if (typeof attestation !== "string" || !attestation) return { ok: false, reason: "attestation_missing" };
  const parts = attestation.split(",");
  if (parts.length !== 3 || parts[0] !== CONSUMER_ATTESTATION_VERSION) {
    return { ok: false, reason: "attestation_malformed" };
  }
  const ts = Number(parts[1]);
  if (!Number.isSafeInteger(ts) || ts <= 0) return { ok: false, reason: "attestation_malformed" };
  if (Math.abs(Date.now() / 1000 - ts) > ATTESTATION_MAX_SKEW_S) {
    return { ok: false, reason: "attestation_expired" };
  }
  const expected = createHmac("sha256", secret)
    .update(attestationMessage({ consumer, traceId, workId, ts: parts[1] }), "utf8")
    .digest();
  let actual;
  try {
    actual = Buffer.from(parts[2], "hex");
  } catch {
    return { ok: false, reason: "attestation_malformed" };
  }
  if (actual.length !== expected.length) return { ok: false, reason: "attestation_mismatch" };
  if (!timingSafeEqual(actual, expected)) return { ok: false, reason: "attestation_mismatch" };
  return { ok: true };
}

/**
 * Sign an attestation (the trusted task proxy side). Kept here so the proxy
 * and the verifier share one canonical wire format.
 */
export function signConsumerAttestation({ consumer, traceId = "", workId = "", secret, nowMs = Date.now() } = {}) {
  const ts = String(Math.floor(nowMs / 1000));
  const mac = createHmac("sha256", secret)
    .update(attestationMessage({ consumer, traceId, workId, ts }), "utf8")
    .digest("hex");
  return `${CONSUMER_ATTESTATION_VERSION},${ts},${mac}`;
}

/**
 * Per-request quota check. Pure + synchronous (local file read). Must run
 * before any provider is contacted and before any fallback logic.
 *
 * @param {object} opts
 * @param {object} opts.heron - Heron correlation values (execution.heron)
 * @param {string|null} opts.model - requested model id (allowlist / free-only checks)
 * @param {string|null} opts.attestation - raw X-Heron-Consumer-Attestation header value
 * @returns {object} gate decision {decision:"allow"|"deny", consumer, reason, message, unmanaged, entry, tokenCeiling}
 */
export function checkSpendGate({ heron = null, model = null, attestation = null } = {}) {
  const consumer = resolveConsumer(heron);
  const heronControlled = hasHeronCorrelation(heron);
  if (heronControlled && !consumer) {
    return deny("unknown", "consumer_identity_required", "Heron-controlled request has no explicit consumer identity; refusing before provider routing.");
  }
  const read = readQuotaState();
  if (!read.ok) {
    return deny(
      consumer,
      read.reason,
      `Spend-gate quota state unavailable (${read.reason}); failing closed. No provider will be contacted.`,
    );
  }
  const entry = read.state.consumers[consumer];
  if (!entry || typeof entry !== "object") {
    if (heronControlled) {
      return deny(consumer, "consumer_unregistered", `Heron-controlled consumer "${consumer}" has no registered quota; refusing before provider routing.`);
    }
    // Governor claims jurisdiction by listing a consumer. Unlisted consumers
    // keep existing behavior (no max_price injection, no cap).
    return allow(consumer, { unmanaged: true });
  }
  // Consumer identity bound to the task/proxy path: attested consumers must
  // carry a valid proxy HMAC. A bare x-heron-consumer header is rejected.
  if (entry.attested === true) {
    const v = (heron && (heron.values || heron)) || {};
    const secret = (process.env[PROXY_HMAC_SECRET_ENV] || "").trim() || null;
    const check = verifyConsumerAttestation({
      consumer,
      traceId: typeof v.trace_id === "string" ? v.trace_id : "",
      workId: typeof v.work_id === "string" ? v.work_id : "",
      attestation,
      secret,
    });
    if (!check.ok) {
      const reason = check.reason === "secret_unconfigured"
        ? "consumer_attestation_unverifiable"
        : "consumer_attestation_failed";
      return deny(
        consumer,
        reason,
        `Consumer "${consumer}" requires a trusted-proxy attestation (${check.reason}); refusing before provider routing.`,
      );
    }
  }
  // A registered consumer with no approved budget fails closed. Budget values
  // need the owner's explicit word; null/unset is never "unlimited" (note:
  // Number(null) === 0, so the raw value must be checked before coercion).
  const rawCap = entry.daily_cap_usd;
  if (rawCap === null || rawCap === undefined || !Number.isFinite(Number(rawCap))) {
    return deny(
      consumer,
      "consumer_budget_unset",
      `Consumer "${consumer}" is registered but has no approved daily budget; failing closed. No provider will be contacted.`,
    );
  }
  const cap = Number(rawCap);
  // Per-consumer model allowlist: refuse rather than substitute.
  if (!consumerAllowsModel(entry, model)) {
    return deny(
      consumer,
      "model_not_permitted",
      `Model "${model}" is not permitted for consumer "${consumer}"; refusing rather than substituting.`,
    );
  }
  // Phase-1 free-only: a paid model for a free-only consumer is terminal.
  if (typeof model === "string" && model.trim() && isFreeOnlyConsumer(entry)) {
    const allowlisted = Array.isArray(entry.allowed_models) && consumerAllowsModel(entry, model);
    if (!allowlisted && !isFreeModelId(model)) {
      return deny(
        consumer,
        "paid_tier_not_permitted",
        `Paid model "${model}" requested for free-only consumer "${consumer}" (Phase-1 policy: no paid fallback); refusing before provider routing.`,
      );
    }
  }
  const spent = Number(entry.spent_today_usd || 0);
  if (Number.isFinite(spent) && spent >= cap) {
    return deny(
      consumer,
      "budget_exhausted",
      `Budget exhausted for consumer "${consumer}": daily cap $${cap.toFixed(2)} reached ($${spent.toFixed(2)} spent). No fallback will be attempted.`,
    );
  }
  return allow(consumer, { entry });
}

/**
 * Resolve the pricing tier for one outbound model attempt.
 * @param {object} gate - decision from checkSpendGate
 * @param {object} opts - {model, freeTierOnly}
 */
export function resolveTier(gate, { model = null, freeTierOnly = false } = {}) {
  if (freeTierOnly || isFreeModelId(model)) return "free";
  // Free-only consumers never route a paid tier: their allowed models are
  // $0-priced via max_price 0/0 injection, and anything else was denied at
  // the gate before routing.
  if (isFreeOnlyConsumer(gate?.entry)) return "free";
  const order = Array.isArray(gate?.entry?.tier_order) ? gate.entry.tier_order : ["free", "paid"];
  return order.find((t) => t && t !== "free") || "paid";
}

/**
 * max_price for a tier, from the consumer's policy. Returns null for unmanaged
 * consumers (no policy -> preserve existing routing behavior).
 */
export function maxPriceForTier(gate, tier) {
  if (!gate || gate.decision !== "allow" || gate.unmanaged) return null;
  if (tier === "free") return { ...FREE_MAX_PRICE };
  const mp = gate.entry && gate.entry.max_price;
  if (mp && Number.isFinite(Number(mp.prompt)) && Number.isFinite(Number(mp.completion))) {
    return { prompt: Number(mp.prompt), completion: Number(mp.completion) };
  }
  return { ...DEFAULT_PAID_MAX_PRICE };
}

/**
 * Convenience: tier + max_price in one call for a model attempt.
 * Returns { tier, maxPrice } with maxPrice null when no policy applies.
 */
export function pricePolicyFor(gate, { model = null, freeTierOnly = false } = {}) {
  const tier = resolveTier(gate, { model, freeTierOnly });
  return { tier, maxPrice: maxPriceForTier(gate, tier) };
}

/**
 * Return a copy of an OpenAI-compatible request body with
 * provider.max_price enforced. The gate wins over any client-supplied
 * max_price; other provider keys (sort, order, ...) are preserved.
 * Only call for OpenRouter-bound requests.
 */
export function withMaxPrice(body, maxPrice) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !maxPrice) return body;
  const prev =
    body.provider && typeof body.provider === "object" && !Array.isArray(body.provider)
      ? body.provider
      : {};
  return {
    ...body,
    provider: {
      ...prev,
      max_price: { prompt: maxPrice.prompt, completion: maxPrice.completion },
    },
  };
}

/**
 * Terminal budget-denied response. HTTP 402 (distinct from retryable 503),
 * machine-readable code "budget_exhausted", retryable:false. HomeNode maps
 * this to a spoken terminal refusal with no retry.
 */
export function budgetExhaustedResponse(gate) {
  const consumer = gate?.consumer || "unknown";
  const reason = gate?.reason || "budget_exhausted";
  const message =
    gate?.message || `Budget exhausted for consumer "${consumer}". No fallback will be attempted.`;
  const payload = {
    error: {
      message,
      type: "budget_error",
      code: BUDGET_EXHAUSTED_CODE,
      consumer,
      reason,
      retryable: false,
    },
  };
  return new Response(JSON.stringify(payload), {
    status: HTTP_STATUS.PAYMENT_REQUIRED,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/** True when a Response is a spend-gate terminal denial (never retry it). */
export function isBudgetExhaustedResponse(res) {
  return !!res && res.status === HTTP_STATUS.PAYMENT_REQUIRED;
}

function governorBaseUrl() {
  return process.env.GOVERNOR_BASE_URL || null;
}

/**
 * Build the spend-report payload for governor's ledger hook from an execution
 * and its recorded usage. Never includes raw API keys.
 */
export function spendReportFromExecution(execution, { status = null, tokens = null, costUsd = null } = {}) {
  const heron = execution?.heron || {};
  const gate = execution?.spendGate || null;
  const tokenCount = (...values) => {
    for (const value of values) {
      const n = Number(value);
      if (Number.isSafeInteger(n) && n >= 0) return n;
    }
    return null;
  };
  const inputTokens = tokenCount(tokens?.input_tokens, tokens?.prompt_tokens, tokens?.prompt, tokens?.input);
  const outputTokens = tokenCount(tokens?.output_tokens, tokens?.completion_tokens, tokens?.completion, tokens?.output);
  const executionId = execution?.executionId || null;
  return {
    schema: "heron.spend_report/v1",
    recorded_at: new Date().toISOString(),
    consumer: gate?.consumer || resolveConsumer(heron),
    request_id: executionId,
    execution_id: executionId,
    trace_id: heron.trace_id || null,
    endpoint: execution?.endpoint || null,
    provider: execution?.actual?.provider || null,
    model: execution?.actual?.model || execution?.requestedModel || null,
    status,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    tokens: tokens && typeof tokens === "object" ? tokens : {},
    cost_usd: Number.isFinite(Number(costUsd)) ? Number(costUsd) : null,
    tier: gate?.tier || null,
    spend_gate: gate ? { decision: gate.decision, reason: gate.reason } : null,
  };
}

/**
 * Best-effort POST of actuals to governor's spend-recording hook. Never throws
 * and never blocks: a down/missing governor must not fail a request.
 * No-op unless GOVERNOR_BASE_URL is set.
 */
export async function reportSpendToGovernor(payload) {
  const base = governorBaseUrl();
  if (!base || !payload) return { status: "not_configured" };
  if (!payload.request_id || payload.input_tokens == null || payload.output_tokens == null || payload.cost_usd == null) {
    console.warn?.(`[9router] governor spend report unverified for ${payload.execution_id || "unknown execution"}: usage or cost missing`);
    return { status: "unverified" };
  }
  let timer;
  try {
    const url = `${base.replace(/\/+$/, "")}/spend`;
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), 2000);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!response.ok) {
      let code = "unknown";
      try { code = (await response.json())?.error || code; } catch { /* omit unparseable body */ }
      console.warn?.(`[9router] governor rejected spend report for ${payload.execution_id}: HTTP ${response.status} (${String(code).slice(0, 80)})`);
      return { status: "rejected", httpStatus: response.status, code };
    }
    return { status: "accepted" };
  } catch (error) {
    console.warn?.(`[9router] governor spend report failed for ${payload.execution_id}: ${error?.name || "transport error"}`);
    return { status: "failed" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Per-consumer outbound OpenRouter key selection.
 *
 * Voice traffic (consumer "homenode-voice") is billed against a dedicated
 * capped OpenRouter key so it can never burn the shared/coding key's budget.
 * When the consumer is the voice consumer, the provider is openrouter, and
 * VOICE_OPENROUTER_KEY is set, return a COPY of the credentials with apiKey
 * swapped to the voice key. Everything else returns the original credentials
 * untouched.
 *
 * Fail-safe: if the env var is missing/empty, fall back to the default
 * connection key and emit a one-line warning (once per process) — voice
 * traffic must never break because the key is absent. The key value is never
 * logged, returned, or persisted by this function.
 *
 * Copy-on-write matters: the stored connection object feeds receipts
 * (masked) and credential persistence; the voice key must reach only the
 * outbound provider request.
 *
 * Orthogonal to the spend gate: quota checks, provider.max_price injection,
 * and budget_exhausted denial apply identically regardless of which key is
 * selected.
 */
export const VOICE_CONSUMER = "homenode-voice";
export const VOICE_KEY_ENV_VAR = "VOICE_OPENROUTER_KEY";

let voiceKeyMissingWarned = false;

/** Reset the once-per-process missing-key warning (tests only). */
export function resetVoiceKeyWarning() {
  voiceKeyMissingWarned = false;
}

export function selectOutboundCredentials(
  credentials,
  { provider = null, heron = null, onWarn = null } = {},
) {
  if (!credentials || provider !== "openrouter") return credentials;
  if (resolveConsumer(heron) !== VOICE_CONSUMER) return credentials;
  const voiceKey = (process.env[VOICE_KEY_ENV_VAR] || "").trim();
  if (!voiceKey) {
    if (!voiceKeyMissingWarned) {
      voiceKeyMissingWarned = true;
      const msg =
        'Spend gate: voice consumer routed to OpenRouter but ' +
        VOICE_KEY_ENV_VAR +
        ' is not set; using the default connection key.';
      try {
        if (typeof onWarn === "function") onWarn(msg);
        else console.warn(msg);
      } catch {
        // warning delivery must never fail the request
      }
    }
    return credentials;
  }
  return { ...credentials, apiKey: voiceKey };
}
