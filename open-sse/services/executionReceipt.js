/**
 * Execution receipt contract (schema_version 1).
 *
 * 9Router answers "what AI execution actually occurred?" — it does NOT decide
 * whether a caller's action was authorized. The Heron trace/intent/work/world
 * identifiers below are correlation metadata only: nothing in this module (or
 * anything that consumes it) may treat them as credentials or privileges.
 *
 * This module is intentionally pure (no DB, no network): handlers record facts
 * into an execution context as they happen, and the app layer persists the
 * resulting receipt. See docs/EXECUTION_RECEIPTS.md for the full contract.
 */

export const RECEIPT_SCHEMA_VERSION = 1;
export const EXECUTION_ID_HEADER = "X-9Router-Execution-Id";
export const EXECUTION_ID_HEADER_LOWER = "x-9router-execution-id";
export const HERON_TRACE_HEADER = "X-Heron-Trace-Id";

// Accepted inbound header vocabulary (case-insensitive).
export const HERON_HEADERS = {
  trace_id: "x-heron-trace-id",
  intent_id: "x-heron-intent-id",
  work_id: "x-heron-work-id",
  world_id: "x-heron-world-id",
};

// Accepted OpenAI `metadata` keys. The dashboard/Heron may use either the
// snake_case wire form or the camelCase JS form; both normalize to the same
// receipt field.
export const HERON_METADATA_KEYS = {
  trace_id: ["heron_trace_id", "heronTraceId"],
  intent_id: ["heron_intent_id", "heronIntentId"],
  work_id: ["heron_work_id", "heronWorkId"],
  world_id: ["heron_world_id", "heronWorldId"],
};
export const RECEIPT_PERSISTENCE_HEADER = "X-9Router-Receipt-Persistence";

const CORRELATION_MAX_LEN = 256;
// Correlation ids are opaque but must be safe to persist/log: reject control
// characters (including CR/LF, which could forge log lines), and cap length.
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

const MAX_ATTEMPTS = 25;
const MAX_MUTATIONS = 25;
const MAX_ERROR_LEN = 500;

/**
 * Trim + validate one correlation identifier.
 * @returns {string|null} normalized value, or null when absent/invalid
 */
export function validateCorrelationId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > CORRELATION_MAX_LEN) return null;
  if (CONTROL_CHARS_RE.test(trimmed)) return null;
  return trimmed;
}

function headerMap(headers) {
  if (!headers) return {};
  if (typeof headers.get === "function") {
    const out = {};
    for (const [k, v] of headers.entries()) out[k.toLowerCase()] = v;
    return out;
  }
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[String(k).toLowerCase()] = v;
  return out;
}

function lookupMetadataValue(metadata, key) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  for (const candidate of HERON_METADATA_KEYS[key]) {
    if (metadata[candidate] !== undefined) return metadata[candidate];
  }
  return undefined;
}

/**
 * Extract Heron correlation from request headers and (when the endpoint
 * supports it) an OpenAI-compatible `metadata` object.
 *
 * Headers win over body metadata. Malformed values are reported under
 * `invalid` and treated as absent — they are never forwarded as privileges.
 *
 * @returns {{present: boolean, values: object, invalid: string[]}}
 */
export function extractHeronCorrelation({ headers, body } = {}) {
  const h = headerMap(headers);
  const metadata = body && typeof body === "object" ? body.metadata : undefined;
  const values = {};
  const invalid = [];

  for (const key of Object.keys(HERON_HEADERS)) {
    const raw = h[HERON_HEADERS[key]] !== undefined ? h[HERON_HEADERS[key]] : lookupMetadataValue(metadata, key);
    if (raw === undefined || raw === null || raw === "") continue;
    const normalized = validateCorrelationId(raw);
    if (normalized) values[key] = normalized;
    else invalid.push(key);
  }

  return {
    present: Object.keys(values).length > 0,
    values,
    invalid,
  };
}

/**
 * Remove Heron-specific keys from an OpenAI `metadata` object so correlation
 * metadata is recorded locally but never blindly forwarded upstream. Returns a
 * new body (the input is not mutated); if metadata would become empty it is
 * removed entirely so strict providers never see an empty object.
 *
 * @returns {{body: object, stripped: string[]}}
 */
export function stripHeronMetadata(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { body, stripped: [] };
  const metadata = body.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return { body, stripped: [] };

  const stripped = [];
  const nextMetadata = { ...metadata };
  for (const candidates of Object.values(HERON_METADATA_KEYS)) {
    for (const candidate of candidates) {
      if (nextMetadata[candidate] !== undefined) {
        delete nextMetadata[candidate];
        stripped.push(candidate);
      }
    }
  }
  if (stripped.length === 0) return { body, stripped };

  const nextBody = { ...body };
  if (Object.keys(nextMetadata).length === 0) delete nextBody.metadata;
  else nextBody.metadata = nextMetadata;
  return { body: nextBody, stripped };
}

export function newExecutionId() {
  const uuid = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : null;
  const rand = uuid || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `9r_exec_${rand}`;
}

function clampError(message) {
  if (message === undefined || message === null) return null;
  const text = typeof message === "string" ? message : String(message?.message || message);
  return text.length > MAX_ERROR_LEN ? `${text.slice(0, MAX_ERROR_LEN)}…` : text;
}

/**
 * Parameter snapshot: only bounded scalar/enumerable request parameters that
 * matter for execution truth. Message/input/prompt bodies are deliberately
 * excluded — the receipt is provenance, not conversation content.
 */
export function snapshotParams(body, { capability = "chat" } = {}) {
  if (!body || typeof body !== "object") return {};
  const out = {};
  const put = (key) => {
    if (body[key] !== undefined) out[key] = body[key];
  };

  put("model");
  put("stream");
  put("seed");
  put("temperature");
  put("top_p");
  put("top_k");
  put("max_tokens");
  put("max_completion_tokens");
  put("presence_penalty");
  put("frequency_penalty");
  put("stop");
  put("n");
  put("user");
  put("reasoning_effort");
  if (body.response_format !== undefined) {
    out.response_format = body.response_format && typeof body.response_format === "object"
      ? { type: body.response_format.type ?? null }
      : body.response_format;
  }
  if (Array.isArray(body.tools)) out.tool_count = body.tools.length;
  if (body.tool_choice !== undefined) out.tool_choice = typeof body.tool_choice === "object" ? body.tool_choice.type ?? null : body.tool_choice;

  if (capability === "image") {
    put("size");
    put("quality");
    put("style");
    put("response_format");
    put("output_format");
    put("background");
    put("moderation");
    delete out.stream;
  }
  if (capability === "tts") {
    put("voice");
    put("response_format");
    put("language");
    put("style");
    delete out.seed;
    delete out.n;
  }
  if (capability === "stt") {
    put("language");
    put("response_format");
    delete out.seed;
    delete out.n;
  }
  return out;
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

function mutationReason(field) {
  if (field === "model") return "upstream_model_id";
  if (field === "seed") return "seed_not_forwarded_upstream";
  if (field === "stream") return "transport_streaming_policy";
  return "provider_compatibility_mapping";
}

/**
 * Diff requested → effective parameters into compatibility mutations.
 * The seed case carries explicit determinism truth: a request that asked for
 * seed 1234 but was sent without it is determinism_honored=false, no matter
 * why the seed disappeared.
 */
export function diffParameterSnapshots(requested = {}, effective = {}) {
  const fields = new Set([...Object.keys(requested), ...Object.keys(effective)]);
  const diffs = [];
  for (const field of fields) {
    if (sameValue(requested[field], effective[field])) continue;
    let action = "changed";
    if (requested[field] !== undefined && effective[field] === undefined) action = "removed";
    else if (requested[field] === undefined && effective[field] !== undefined) action = "added";
    diffs.push({ field, action, requested_value: requested[field] ?? null, effective_value: effective[field] ?? null });
  }
  return diffs;
}

export function createExecution({
  endpoint,
  capability = "chat",
  requestedModel = null,
  requestedCombo = null,
  requestedProvider = null,
  heron = null,
  requestedParams = {},
  connectionIdentity = null,
  apiKeyMasked = null,
  timestamp = Date.now(),
  executionId = null,
  parentExecutionId = null,
} = {}) {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    executionId: executionId || newExecutionId(),
    parentExecutionId: parentExecutionId || null,
    startedAt: new Date(timestamp).toISOString(),
    startedAtMs: timestamp,
    endedAt: null,
    endpoint: endpoint || null,
    capability,
    status: "in_progress",
    error: null,
    requestedModel,
    requestedCombo: requestedCombo || null,
    requestedAlias: null,
    requestedProvider: requestedProvider || null,
    heron: heron?.present ? heron.values : null,
    heronInvalid: heron?.invalid?.length ? heron.invalid : null,
    requestedParams: requestedParams || {},
    effectiveParams: null,
    compatibilityMutations: [],
    optimizations: [],
    attempts: [],
    attemptsTruncated: 0,
    actual: null,
    routingReason: null,
    routingCandidates: null,
    streaming: false,
    usage: null,
    cost: null,
    latency: { total_ms: null, routing_ms: null, upstream_ms: null, ttft_ms: null },
    apiKeyMasked: apiKeyMasked || null,
    connectionIdentity: connectionIdentity || null,
    usageRecorded: false,
    receiptPersisted: false,
    evidenceStatus: "degraded",
  };
}

export function setRouting(execution, { reason = null, candidates = null, requestedCombo, requestedProvider } = {}) {
  if (!execution) return;
  if (reason) execution.routingReason = reason;
  if (Array.isArray(candidates)) execution.routingCandidates = candidates.slice(0, 50);
  if (requestedCombo !== undefined) execution.requestedCombo = requestedCombo || null;
  if (requestedProvider !== undefined) execution.requestedProvider = requestedProvider || null;
}

export function beginAttempt(execution, info = {}) {
  if (!execution) return null;
  const attempt = {
    n: execution.attempts.length + 1,
    started_at: new Date().toISOString(),
    _startedAtMs: Date.now(),
    candidate: info.candidate || null,
    provider: info.provider || null,
    model: info.model || null,
    connection: info.connection || null,
    reason: info.reason || "primary",
    status: "in_progress",
    status_code: null,
    error: null,
    latency_ms: null,
    upstream_ms: null,
    compatibility_mutations: [],
  };
  if (execution.attempts.length < MAX_ATTEMPTS) execution.attempts.push(attempt);
  else execution.attemptsTruncated += 1;
  execution.currentAttempt = attempt;
  return attempt;
}

function attemptCounters(attempts = []) {
  const errors = attempts.filter((a) => a.status === "error");
  return {
    total_attempts: attempts.length,
    model_fallbacks: errors.filter((a) => a.n > 1 && !/account_fallback|token_refresh|credential/i.test(String(a.reason || ""))).length,
    account_fallbacks: errors.filter((a) => a.reason === "account_fallback").length,
    token_refresh_retries: errors.filter((a) => /token_refresh|refresh/i.test(String(a.reason || ""))).length,
    credential_failures: errors.filter((a) => /credential/i.test(String(a.reason || ""))).length,
    fallback_count: errors.length,
  };
}

export function endAttempt(execution, attempt, { success = false, status = null, error = null, startedAtMs = null } = {}) {
  if (!attempt) return;
  attempt.status = success ? "success" : "error";
  attempt.status_code = status ?? attempt.status_code ?? null;
  attempt.error = clampError(error);
  const started = startedAtMs ?? attempt._startedAtMs;
  attempt.latency_ms = started ? Date.now() - started : null;
  delete attempt._startedAtMs;
  if (execution?.currentAttempt === attempt) execution.currentAttempt = null;
}

export function recordCompatibilityMutation(execution, mutation) {
  if (!execution || !mutation || !mutation.field) return;
  const record = {
    field: mutation.field,
    action: mutation.action || "changed",
    reason: mutation.reason || mutationReason(mutation.field),
    attempt: mutation.attempt ?? execution.attempts.length ?? null,
    requested_value: mutation.requestedValue ?? null,
    effective_value: mutation.effectiveValue ?? null,
    determinism_honored: mutation.determinismHonored ?? (mutation.field !== "seed"),
    detail: mutation.detail ? clampError(mutation.detail) : null,
  };
  if (execution.compatibilityMutations.length < MAX_MUTATIONS) {
    execution.compatibilityMutations.push(record);
  }
  const attempt = execution.attempts[execution.attempts.length - 1];
  if (attempt && attempt.compatibility_mutations.length < MAX_MUTATIONS) {
    attempt.compatibility_mutations.push(record);
  }
  return record;
}

export function recordOptimization(execution, { name, detail = null } = {}) {
  if (!execution || !name) return;
  if (execution.optimizations.some((o) => o.name === name)) return;
  execution.optimizations.push({ name, detail: detail ? clampError(detail) : null });
}

/**
 * Record the effective (post-translation / post-adapter) parameters and turn
 * any requested→effective difference into compatibility mutations.
 */
export function recordEffectiveParams(execution, effectiveParams) {
  if (!execution) return;
  execution.effectiveParams = effectiveParams || {};
  for (const diff of diffParameterSnapshots(execution.requestedParams || {}, execution.effectiveParams)) {
    recordCompatibilityMutation(execution, {
      field: diff.field,
      action: diff.action,
      requestedValue: diff.requested_value,
      effectiveValue: diff.effective_value,
      reason: mutationReason(diff.field),
    });
  }
}

/**
 * Explicit seed-application truth (used by the image path where a retry may
 * drop the seed after an upstream rejection). Replaces any generic diff-derived
 * seed mutation so the receipt carries exactly one, most-specific seed record.
 */
export function recordSeedApplication(execution, { requested, applied, attempt = null, reason = null, detail = null }) {
  if (!execution) return;
  if (requested === undefined || requested === null) return;
  if (!applied) {
    execution.compatibilityMutations = (execution.compatibilityMutations || []).filter((m) => m.field !== "seed");
    for (const a of execution.attempts || []) {
      a.compatibility_mutations = (a.compatibility_mutations || []).filter((m) => m.field !== "seed");
    }
    execution.effectiveParams = { ...(execution.effectiveParams || {}), seed: null };
    recordCompatibilityMutation(execution, {
      field: "seed",
      action: "removed",
      reason: reason || "upstream_rejected_parameter",
      attempt,
      requestedValue: requested,
      effectiveValue: null,
      determinismHonored: false,
      detail,
    });
  } else {
    execution.effectiveParams = { ...(execution.effectiveParams || {}), seed: requested };
  }
}

export function sanitizeConnectionIdentity(credentials) {
  if (!credentials) return null;
  const id = credentials.connectionId || credentials.id || null;
  const label = credentials.connectionName || credentials.name || credentials.email || null;
  const authType = credentials.authType || null;
  if (!id && !label && !authType) return null;
  return {
    id: id ? String(id).slice(0, 128) : null,
    label: label ? String(label).slice(0, 128) : null,
    auth_type: authType ? String(authType).slice(0, 32) : null,
  };
}

export function recordActual(execution, { provider, model, connectionId, connectionLabel, authType } = {}) {
  if (!execution) return;
  execution.actual = {
    provider: provider || null,
    model: model || null,
    connection: {
      id: connectionId || null,
      label: connectionLabel || null,
      auth_type: authType || null,
    },
  };
}

export function setStreaming(execution, streaming) {
  if (execution) execution.streaming = streaming === true;
}

export function recordUsage(execution, usage) {
  if (!execution || !usage || typeof usage !== "object") return;
  execution.usage = {
    prompt_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    completion_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? ((usage.prompt_tokens ?? usage.input_tokens ?? 0) + (usage.completion_tokens ?? usage.output_tokens ?? 0)),
    cached_tokens: usage.cached_tokens ?? usage.cache_read_input_tokens ?? 0,
  };
}

export function recordCost(execution, cost, state) {
  if (!execution) return;
  execution.cost = {
    amount: Number(cost) || 0,
    currency: "USD",
    state: state || "unknown",
  };
}

export function recordLatency(execution, patch = {}) {
  if (!execution) return;
  execution.latency = { ...execution.latency, ...patch };
}

export function finalizeExecutionState(execution, { status, error = null, endedAt = Date.now() } = {}) {
  if (!execution) return;
  if (status) execution.status = status;
  execution.error = error ? { message: clampError(error?.message || error), status_code: error?.status_code ?? null } : null;
  execution.endedAt = new Date(endedAt).toISOString();
  if (execution.latency.total_ms == null) execution.latency.total_ms = endedAt - execution.startedAtMs;
}

function seedTruth(execution) {
  const requested = execution.requestedParams?.seed;
  if (requested === undefined || requested === null) {
    return { seed_requested: null, seed_applied: null, determinism_honored: null };
  }
  const effective = execution.effectiveParams?.seed;
  const mutation = execution.compatibilityMutations.find((m) => m.field === "seed");
  const applied = effective !== undefined && effective !== null && sameValue(effective, requested);
  return {
    seed_requested: requested,
    seed_applied: applied && !mutation,
    determinism_honored: applied && !mutation,
  };
}

/** Build the durable receipt (contract schema_version 1). */
export function buildExecutionReceipt(execution) {
  if (!execution) return null;
  const seed = seedTruth(execution);
  const counters = attemptCounters(execution.attempts);
  return {
    schema_version: execution.schemaVersion,
    execution_id: execution.executionId,
    parent_execution_id: execution.parentExecutionId || null,
    started_at: execution.startedAt,
    ended_at: execution.endedAt,
    endpoint: execution.endpoint,
    capability: execution.capability,
    status: execution.status,
    evidence_status: execution.evidenceStatus || "degraded",
    error: execution.error,
    heron: execution.heron
      ? {
          trace_id: execution.heron.trace_id ?? null,
          intent_id: execution.heron.intent_id ?? null,
          work_id: execution.heron.work_id ?? null,
          world_id: execution.heron.world_id ?? null,
        }
      : null,
    heron_invalid: execution.heronInvalid || null,
    request: {
      model: execution.requestedModel,
      alias_or_combo: execution.requestedCombo || execution.requestedAlias || null,
      provider: execution.requestedProvider,
      params: execution.requestedParams,
      effective_params: execution.effectiveParams,
    },
    routing: {
      reason: execution.routingReason,
      requested_combo: execution.requestedCombo,
      candidates: execution.routingCandidates,
      selected: execution.actual,
      ...counters,
    },
    attempts: execution.attempts.map((a) => ({
      n: a.n,
      started_at: a.started_at,
      candidate: a.candidate,
      provider: a.provider,
      model: a.model,
      connection: a.connection,
      reason: a.reason,
      status: a.status,
      status_code: a.status_code,
      error: a.error,
      latency_ms: a.latency_ms,
      upstream_ms: a.upstream_ms,
      compatibility_mutations: a.compatibility_mutations,
    })),
    attempts_truncated: execution.attemptsTruncated || 0,
    actual: execution.actual,
    latency: {
      total_ms: execution.latency.total_ms,
      routing_ms: execution.latency.routing_ms,
      upstream_ms: execution.latency.upstream_ms,
      ttft_ms: execution.latency.ttft_ms,
    },
    usage: execution.usage,
    cost: execution.cost || { amount: 0, currency: "USD", state: "unknown" },
    compatibility_mutations: execution.compatibilityMutations,
    optimizations: execution.optimizations,
    determinism: seed,
  };
}

/**
 * Compact, query-worthy summary persisted in usageHistory.meta. Keeps the
 * causal truth (requested vs actual, attempts, seed, cost state) without
 * duplicating the full receipt.
 */
export function buildUsageMeta(execution) {
  if (!execution) return null;
  const receipt = buildExecutionReceipt(execution);
  const counters = attemptCounters(receipt.attempts);
  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    execution_id: receipt.execution_id,
    parent_execution_id: receipt.parent_execution_id || null,
    heron: receipt.heron,
    requested: {
      model: receipt.request.model,
      alias_or_combo: receipt.request.alias_or_combo,
      provider: receipt.request.provider,
    },
    actual: receipt.actual
      ? {
          provider: receipt.actual.provider,
          model: receipt.actual.model,
          connection_id: receipt.actual.connection?.id || null,
          connection_label: receipt.actual.connection?.label || null,
        }
      : null,
    routing_reason: receipt.routing.reason,
    attempts: receipt.attempts.length + (receipt.attempts_truncated || 0),
    fallbacks: counters.fallback_count,
    ...counters,
    evidence_status: receipt.evidence_status,
    compatibility_mutations: receipt.compatibility_mutations,
    determinism: receipt.determinism,
    status: receipt.status,
    streamed: execution.streaming === true,
    cost_state: receipt.cost.state,
  };
}

/** Safe response headers for a completed/streaming execution. */
export function executionResponseHeaders(execution) {
  if (!execution) return {};
  const headers = { [EXECUTION_ID_HEADER]: execution.executionId };
  if (execution.heron?.trace_id) headers[HERON_TRACE_HEADER] = execution.heron.trace_id;
  if (execution.evidenceStatus) headers[RECEIPT_PERSISTENCE_HEADER] = execution.evidenceStatus;
  return headers;
}

/**
 * Attach execution identity to a Response without touching the body, status, or
 * existing headers. Works for JSON, SSE, and binary (image/audio) responses.
 */
export function attachExecutionHeaders(response, execution) {
  if (!response || !execution) return response;
  try {
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(executionResponseHeaders(execution))) headers.set(k, v);
    const existingExpose = headers.get("Access-Control-Expose-Headers");
    const expose = new Set(
      [EXECUTION_ID_HEADER, HERON_TRACE_HEADER, RECEIPT_PERSISTENCE_HEADER, ...(existingExpose ? existingExpose.split(",").map((s) => s.trim()) : [])]
        .filter(Boolean)
    );
    headers.set("Access-Control-Expose-Headers", [...expose].join(", "));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}

export const __test__ = {
  clampError,
  mutationReason,
  sameValue,
  MAX_ATTEMPTS,
  MAX_MUTATIONS,
};
