import {
  extractApiKey, isValidApiKey,
  getProviderCredentials, markAccountUnavailable,
} from "../services/auth.js";
import { getSettings, getComboByName } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { handleTtsCore } from "open-sse/handlers/ttsCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { handleComboChat } from "open-sse/services/combo.js";
import * as log from "../utils/logger.js";
import {
  createExecution, extractHeronCorrelation, stripHeronMetadata,
  snapshotParams, setRouting, beginAttempt, endAttempt,
  sanitizeConnectionIdentity, attachExecutionHeaders, finalizeExecutionState,
} from "open-sse/services/executionReceipt.js";
import { finalizeExecution, recordExecutionUsage } from "@/lib/execution/receiptStore.js";
import { checkSpendGate, budgetExhaustedResponse, pricePolicyFor, selectOutboundCredentials } from "@/lib/spendGate.js";

// Derived from providers.js: any TTS provider not noAuth requires stored credentials
const CREDENTIALED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.serviceKinds?.includes("tts") && !p.noAuth && p.ttsConfig?.authType !== "none")
    .map(([id]) => id)
);

export async function handleTts(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const heron = extractHeronCorrelation({
    headers: Object.fromEntries(request.headers.entries()),
    body,
  });
  const { body: strippedBody } = stripHeronMetadata(body);
  body = strippedBody;

  const execution = createExecution({
    endpoint: url.pathname,
    capability: "tts",
    requestedModel: typeof body.model === "string" ? body.model : null,
    requestedProvider: (typeof body.model === "string" && body.model.includes("/"))
      ? body.model.slice(0, body.model.indexOf("/"))
      : null,
    heron,
    requestedParams: snapshotParams(body, { capability: "tts" }),
  });

  try {
    let response;
    try {
      response = await handleTtsWithExecution(request, body, execution);
    } catch (e) {
      if (execution.currentAttempt) endAttempt(execution, execution.currentAttempt, { success: false, status: HTTP_STATUS.BAD_GATEWAY, error: String(e?.message || e).slice(0, 500) });
      finalizeExecutionState(execution, { status: "error", error: { message: String(e?.message || e).slice(0, 500), status_code: HTTP_STATUS.BAD_GATEWAY } });
      if (!execution.usageRecorded) {
        recordExecutionUsage(execution, {
          provider: execution.actual?.provider || null,
          model: execution.actual?.model || (typeof body.model === "string" ? body.model : null),
          connectionId: execution.actual?.connection?.id || null,
          apiKey: extractApiKey(request) || null,
          endpoint: execution.endpoint,
          status: "error",
          tokens: {},
        }).catch(() => {});
      }
      return attachExecutionHeaders(errorResponse(HTTP_STATUS.BAD_GATEWAY, "Internal server error"), execution);
    }
    if (!execution.endedAt) {
      finalizeExecutionState(execution, response.ok
        ? { status: "success" }
        : { status: "error", error: { message: null, status_code: response.status } });
    }
    if (!execution.usageRecorded) {
      recordExecutionUsage(execution, {
        provider: execution.actual?.provider || null,
        model: execution.actual?.model || (typeof body.model === "string" ? body.model : null),
        connectionId: execution.actual?.connection?.id || null,
        apiKey: (response.status === 401 || response.status === 403) ? null : (extractApiKey(request) || null),
        endpoint: execution.endpoint,
        status: response.ok ? "success" : "error",
        tokens: {},
      }).catch(() => {});
    }
    return attachExecutionHeaders(response, execution);
  } finally {
    finalizeExecution(execution).catch(() => {});
  }
}

async function handleTtsWithExecution(request, body, execution) {
  const url = new URL(request.url);
  const modelStr = body.model;
  const responseFormat = url.searchParams.get("response_format") || "mp3"; // mp3 (default) | json
  const language = body.language || ""; // Optional language hint (currently used by Gemini)
  const style = body.style || ""; // Optional style/voice instructions (e.g. Xiaomi MiMo)
  log.request("POST", `${url.pathname} | ${modelStr} | format=${responseFormat}${language ? ` | lang=${language}` : ""}`);

  const settings = await getSettings();
  const apiKey = extractApiKey(request);
  if (execution) execution.apiKeyMasked = apiKey ? log.maskKey(apiKey) : null;
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!body.input) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");

  // Spend gate: per-request quota check before any provider is contacted.
  // A deny is terminal (no retry, no fallback).
  const spendGate = checkSpendGate({ heron: execution?.heron });
  if (execution) execution.spendGate = spendGate;
  if (spendGate.decision === "deny") {
    log.warn("SPEND", `Budget deny for consumer "${spendGate.consumer}": ${spendGate.reason}`);
    return budgetExhaustedResponse(spendGate);
  }

  // Combo expansion: model may be a combo name → run fallback/round-robin across models
  const comboRow = modelStr.includes("/") ? null : await getComboByName(modelStr);
  const comboModels = comboRow?.models?.length ? comboRow.models : null;
  if (comboModels) {
    const freeTierOnly = comboRow.kind === "free-tier";
    if (execution?.spendGate) execution.spendGate.comboFreeTier = freeTierOnly;
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    setRouting(execution, { reason: `combo_${comboStrategy}`, requestedCombo: modelStr, candidates: comboModels });
    log.info("TTS", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelTts(b, m, responseFormat, language, style, apiKey, execution),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      freeTierOnly,
    });
  }

  return handleSingleModelTts(body, modelStr, responseFormat, language, style, apiKey, execution);
}

async function handleSingleModelTts(body, modelStr, responseFormat, language, style, apiKey, execution) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;
  if (execution) {
    setRouting(execution, { reason: execution.routingReason || "direct" });
    if (!execution.requestedCombo && !String(modelStr).includes("/") && modelStr !== model) {
      execution.requestedAlias = modelStr;
    }
  }
  // Spend gate: price tag for OpenRouter-bound TTS. Unmanaged consumers
  // (no governor quota entry) keep existing behavior.
  let ttsMaxPrice = null;
  const tsg = execution?.spendGate;
  if (tsg && tsg.decision === "allow" && provider === "openrouter") {
    const policy = pricePolicyFor(tsg, { model: modelStr, freeTierOnly: tsg.comboFreeTier === true });
    tsg.tier = policy.tier;
    ttsMaxPrice = policy.maxPrice;
  }
  log.info("ROUTING", `Provider: ${provider}, Voice: ${model}`);

  // noAuth providers — no credential needed
  if (!CREDENTIALED_PROVIDERS.has(provider)) {
    const attempt = beginAttempt(execution, { candidate: modelStr, provider, model, reason: "primary" });
    const result = await handleTtsCore({ provider, model, input: body.input, responseFormat, language, style, maxPrice: ttsMaxPrice });
    endAttempt(execution, attempt, { success: result.success, status: result.status, error: result.error });
    if (result.success) {
      await recordExecutionUsage(execution, {
        provider, model, connectionId: null, apiKey: null, endpoint: "/v1/audio/speech", status: "success", tokens: {},
      });
      return result.response;
    }
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "TTS failed");
  }

  // Credentialed providers — fallback loop (same pattern as embeddings)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    if (!credentials || credentials.allRateLimited) {
      if (execution) {
        const a = beginAttempt(execution, { candidate: modelStr, provider, model, reason: "credentials_unavailable" });
        endAttempt(execution, a, {
          success: false,
          status: credentials?.allRateLimited ? HTTP_STATUS.SERVICE_UNAVAILABLE : (excludeConnectionIds.size === 0 ? HTTP_STATUS.BAD_REQUEST : (lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE)),
          error: credentials?.lastError || lastError || "All accounts unavailable",
        });
      }
      if (credentials?.allRateLimited) {
        const msg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model}] ${msg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const attempt = beginAttempt(execution, {
      candidate: modelStr,
      provider,
      model,
      connection: sanitizeConnectionIdentity(credentials),
      reason: excludeConnectionIds.size > 0 ? "account_fallback" : "primary",
    });

    // Per-consumer key selection: voice traffic uses the dedicated capped
    // OpenRouter key when set. Copy-on-write: the stored connection object
    // (receipts, credential persistence) is never mutated.
    const outboundCredentials = selectOutboundCredentials(credentials, {
      provider,
      heron: execution?.heron,
      onWarn: (m) => log.warn("SPEND", m),
    });
    const result = await handleTtsCore({ provider, model, input: body.input, credentials: outboundCredentials, responseFormat, language, style, maxPrice: ttsMaxPrice });
    endAttempt(execution, attempt, { success: result.success, status: result.status, error: result.error });

    if (result.success) {
      await recordExecutionUsage(execution, {
        provider,
        model,
        connectionId: credentials.connectionId,
        apiKey,
        endpoint: "/v1/audio/speech",
        status: "success",
        tokens: {},
      });
      return result.response;
    }

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);
    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }
    return result.response || errorResponse(result.status, result.error);
  }
}
