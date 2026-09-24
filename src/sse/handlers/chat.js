import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSettings, getComboByName } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities, filterFreeTierModels } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import {
  createExecution, extractHeronCorrelation, stripHeronMetadata,
  snapshotParams, setRouting, beginAttempt, endAttempt,
  sanitizeConnectionIdentity, attachExecutionHeaders, finalizeExecutionState,
  newExecutionId,
} from "open-sse/services/executionReceipt.js";
import { finalizeExecution, recordExecutionUsage } from "@/lib/execution/receiptStore.js";
import { checkSpendGate, budgetExhaustedResponse, pricePolicyFor, withMaxPrice, selectOutboundCredentials, CONSUMER_ATTESTATION_HEADER } from "@/lib/spendGate.js";

function executionCapability(pathname) {
  if (pathname.includes("/responses")) return "responses";
  return "chat";
}

function clampMessage(e, max = 500) {
  const text = typeof e === "string" ? e : e?.message || String(e);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Fork an execution context for a parallel fusion panel call. Each panel
 * sub-model runs really and gets its own execution_id linked to the parent via
 * parent_execution_id — so the causal record is one tree, not N collisions.
 */
export function forkComboExecution(parent, { candidate, reason = "fusion_panel" } = {}) {
  if (!parent) return null;
  const fork = createExecution({
    endpoint: parent.endpoint,
    capability: parent.capability,
    executionId: newExecutionId(),
    parentExecutionId: parent.executionId,
    requestedModel: parent.requestedModel,
    requestedCombo: parent.requestedCombo || parent.requestedAlias || null,
    requestedProvider: parent.requestedProvider,
    heron: parent.heron ? { present: true, values: parent.heron, invalid: parent.heronInvalid || [] } : null,
    requestedParams: parent.requestedParams,
    apiKeyMasked: parent.apiKeyMasked,
  });
  setRouting(fork, { reason, requestedCombo: parent.requestedCombo || parent.requestedAlias || null, candidates: [candidate] });
  return fork;
}

export function finalizeForkedExecution(fork, result, { apiKey = null, endpoint = null } = {}) {
  if (!fork) return;
  const ok = !!(result && (result.ok === true || result.status === 200));
  const errorObj = result && typeof result === "object"
    ? { message: result.message || result.error || null, status_code: result.status || null }
    : { message: typeof result === "string" ? result : null, status_code: null };
  // Close any attempt a throwing panel call left open — a terminal receipt
  // must never carry an "in_progress" attempt.
  for (const a of fork.attempts) {
    if (a.status === "in_progress") {
      endAttempt(fork, a, { success: ok, status: errorObj.status_code, error: errorObj.message });
    }
  }
  finalizeExecutionState(fork, ok
    ? { status: "success" }
    : { status: "error", error: errorObj });
  finalizeExecution(fork).catch(() => {});
  // Forks on zero-usage successes and rejected panels still need their durable
  // usageHistory summary (the parent wrapper covers the parent only). An
  // auth-rejected panel (401/403) must not persist the supplied key.
  if (!fork.usageRecorded) {
    recordExecutionUsage(fork, {
      provider: fork.actual?.provider || null,
      model: fork.actual?.model || fork.requestedModel || null,
      connectionId: fork.actual?.connection?.id || null,
      apiKey: (errorObj.status_code === 401 || errorObj.status_code === 403) ? null : apiKey,
      endpoint: endpoint || fork.endpoint,
      status: ok ? "success" : "error",
      tokens: {},
    }).catch(() => {});
  }
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);

  // Heron correlation: opaque ids from headers and/or OpenAI `metadata`. They
  // are correlation metadata only — they never grant privileges. Malformed
  // values are dropped (reported under `heron_invalid` on the receipt).
  const heron = extractHeronCorrelation({
    headers: Object.fromEntries(request.headers.entries()),
    body,
  });
  const { body: strippedBody } = stripHeronMetadata(body);
  body = strippedBody;

  const execution = createExecution({
    endpoint: url.pathname,
    capability: executionCapability(url.pathname),
    requestedModel: typeof body.model === "string" ? body.model : null,
    requestedProvider: (typeof body.model === "string" && body.model.includes("/"))
      ? body.model.slice(0, body.model.indexOf("/"))
      : null,
    heron,
    requestedParams: snapshotParams(body, { capability: "chat" }),
  });

  try {
    let response;
    try {
      response = await handleChatWithExecution(request, body, clientRawRequest, execution);
    } catch (e) {
      // A throw in the routing/fallback layer must still produce a terminal
      // receipt + durable summary (never a stuck "in_progress").
      log.error?.("CHAT", `Routing error: ${e?.message || e}`);
      if (execution.currentAttempt) endAttempt(execution, execution.currentAttempt, { success: false, status: HTTP_STATUS.BAD_GATEWAY, error: clampMessage(e) });
      finalizeExecutionState(execution, { status: "error", error: { message: clampMessage(e), status_code: HTTP_STATUS.BAD_GATEWAY } });
      if (!execution.usageRecorded) {
        recordExecutionUsage(execution, {
          provider: execution.actual?.provider || null,
          model: execution.actual?.model || execution.requestedModel || null,
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
      const ok = response.ok;
      if (!ok) {
        const lastErr = execution.attempts.length ? execution.attempts[execution.attempts.length - 1].error : null;
        // A rejection converted by an outer handler (e.g. handleComboChat
        // catch-all) leaves in-flight attempts open; close every one of them.
        for (const a of execution.attempts) {
          if (a.status === "in_progress") endAttempt(execution, a, { success: false, status: response.status, error: lastErr });
        }
        finalizeExecutionState(execution, { status: "error", error: { message: lastErr || null, status_code: response.status } });
      } else {
        finalizeExecutionState(execution, { status: execution.streaming ? "streaming" : "success" });
      }
    }
    // Durable identity covers every routed execution: the compact usageHistory
    // summary (indexed executionId/traceId) is written for failures AND for
    // successes whose usage path wrote nothing (zero/absent tokens, bypass).
    if (!execution.usageRecorded) {
      if (!response.ok || (response.ok && !execution.streaming)) {
        recordExecutionUsage(execution, {
          provider: execution.actual?.provider || (execution.routingCandidates?.[0] ? String(execution.routingCandidates[0]).split("/")[0] : null) || null,
          model: execution.actual?.model || execution.requestedModel || null,
          connectionId: execution.actual?.connection?.id || null,
          // Auth-rejected requests must not persist the supplied (possibly
          // attacker-chosen) Authorization value in the DB.
          apiKey: (response.status === 401 || response.status === 403) ? null : (extractApiKey(request) || null),
          endpoint: execution.endpoint,
          status: response.ok ? "success" : "error",
          tokens: {},
        }).catch(() => {});
      }
    }
    return attachExecutionHeaders(response, execution);
  } finally {
    // Provisional/terminal persistence. Streaming supersedes this later via
    // onStreamComplete / disconnect callbacks (UPSERT on the same id).
    finalizeExecution(execution).catch(() => {});
  }
}

/**
 * Chat routing (combo expansion, account fallback) — keeps a single execution
 * context across the whole client request so combo/fallback produce ONE causal
 * record with ordered attempts.
 */
async function handleChatWithExecution(request, body, clientRawRequest, execution) {
  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (execution) execution.apiKeyMasked = apiKey ? log.maskKey(apiKey) : null;
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Spend gate: per-request quota check. Runs before any provider is contacted
  // and before any fallback logic; a deny is terminal (no retry, no fallback).
  const spendGate = checkSpendGate({
    heron: execution?.heron,
    model: modelStr,
    attestation: request.headers.get(CONSUMER_ATTESTATION_HEADER),
  });
  if (execution) execution.spendGate = spendGate;
  if (spendGate.decision === "deny") {
    log.warn("SPEND", `Budget deny for consumer "${spendGate.consumer}": ${spendGate.reason}`);
    return budgetExhaustedResponse(spendGate);
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboRow = await getComboByName(modelStr);
  const comboModels = comboRow?.models?.length ? comboRow.models : null;
  if (comboModels) {
    const freeTierOnly = comboRow?.kind === "free-tier";
    if (execution?.spendGate) execution.spendGate.comboFreeTier = freeTierOnly;
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const policyModels = freeTierOnly ? filterFreeTierModels(comboModels) : comboModels;
    const augmentedModels = policyModels.length
      ? augmentModelsWithCapacityAdapter(policyModels, requiredCapabilities, settings)
      : [];
    const finalModels = freeTierOnly ? filterFreeTierModels(augmentedModels) : augmentedModels;
    const adapterAdded = finalModels.filter((m) => !policyModels.includes(m));

    setRouting(execution, {
      reason: comboStrategy === "fusion" ? "fusion_panel" : `combo_${comboStrategy}`,
      requestedCombo: modelStr,
      candidates: finalModels,
    });

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: finalModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          const panelExecution = isPanel ? forkComboExecution(execution, { candidate: m }) : execution;
          const result = handleSingleModelChat(b, m, cleanRawReq, request, apiKey, panelExecution);
          if (panelExecution !== execution) {
            const settled = Promise.resolve(result);
            settled.then((res) => finalizeForkedExecution(panelExecution, res, { apiKey })).catch((err) => finalizeForkedExecution(panelExecution, err, { apiKey }));
          }
          return result;
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
        freeTierOnly,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: finalModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, execution),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      freeTierOnly,
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    setRouting(execution, { reason: "capacity_adapter", requestedCombo: modelStr, candidates: soloAugmented });
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, execution),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, execution);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, execution = null) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    // getModelInfo already resolved the combo row (single lookup) — reuse it.
    const comboRow = modelInfo.combo;
    const comboModels = comboRow?.models?.length ? comboRow.models : null;
    if (comboModels) {
      const freeTierOnly = comboRow?.kind === "free-tier";
    if (execution?.spendGate) execution.spendGate.comboFreeTier = freeTierOnly;
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const policyModels = freeTierOnly ? filterFreeTierModels(comboModels) : comboModels;
      const augmentedModels = policyModels.length
        ? augmentModelsWithCapacityAdapter(policyModels, requiredCapabilities, chatSettings)
        : [];
      const finalModels = freeTierOnly ? filterFreeTierModels(augmentedModels) : augmentedModels;
      const adapterAdded = finalModels.filter((m) => !policyModels.includes(m));

      setRouting(execution, {
        reason: comboStrategy === "fusion" ? "fusion_panel" : `combo_${comboStrategy}`,
        requestedCombo: modelStr,
        candidates: finalModels,
      });

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: finalModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            const panelExecution = isPanel ? forkComboExecution(execution, { candidate: m }) : execution;
            const result = handleSingleModelChat(b, m, cleanRawReq, request, apiKey, panelExecution);
            if (panelExecution !== execution) {
              const settled = Promise.resolve(result);
              settled.then((res) => finalizeForkedExecution(panelExecution, res, { apiKey })).catch((err) => finalizeForkedExecution(panelExecution, err, { apiKey }));
            }
            return result;
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
          freeTierOnly,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: finalModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, execution),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        freeTierOnly,
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;
  // Spend gate: enforce the price tag on OpenRouter-bound requests. Tier comes
  // from the combo's free-tier policy (stashed above) or the model id itself.
  // Unmanaged consumers (no governor quota entry) keep existing behavior.
  const sg = execution?.spendGate;
  if (sg && sg.decision === "allow" && provider === "openrouter") {
    const { tier, maxPrice } = pricePolicyFor(sg, { model: modelStr, freeTierOnly: sg.comboFreeTier === true });
    sg.tier = tier;
    if (maxPrice) body = withMaxPrice(body, maxPrice);
  }
  if (execution) {
    setRouting(execution, { reason: execution.routingReason || "direct" });
    // A bare model string that resolved to provider/model is an alias.
    if (!execution.requestedCombo && !String(modelStr).includes("/") && modelStr !== model) {
      execution.requestedAlias = modelStr;
    }
  }

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (execution) {
        const a = beginAttempt(execution, { candidate: modelStr, provider, model, reason: "credentials_unavailable" });
        endAttempt(execution, a, {
          success: false,
          status: credentials?.allRateLimited ? HTTP_STATUS.SERVICE_UNAVAILABLE : (excludeConnectionIds.size === 0 ? HTTP_STATUS.NOT_FOUND : (lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE)),
          error: credentials?.lastError || lastError || "All accounts unavailable",
        });
      }
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Per-consumer key selection: voice traffic uses the dedicated capped
    // OpenRouter key when set. Copy-on-write: the stored connection object
    // (receipts, credential persistence) is never mutated.
    const outboundCredentials = selectOutboundCredentials(refreshedCredentials, {
      provider,
      heron: execution?.heron,
      onWarn: (m) => log.warn("SPEND", m),
    });

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // One receipt attempt per upstream dispatch (account fallbacks are ordered).
    const attempt = beginAttempt(execution, {
      candidate: modelStr,
      provider,
      model,
      connection: sanitizeConnectionIdentity(credentials),
      reason: excludeConnectionIds.size > 0 ? "account_fallback" : "primary",
    });

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: outboundCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      execution,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
      }
    });

    endAttempt(execution, attempt, { success: result.success, status: result.status, error: result.error });

    if (result.success) return result.response;

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : (await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs)).shouldFallback;

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
