import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleImageGenerationCore } from "open-sse/handlers/imageGenerationCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleComboChat } from "open-sse/services/combo.js";
import * as log from "../utils/logger.js";
import {
  createExecution, extractHeronCorrelation, stripHeronMetadata,
  snapshotParams, setRouting, beginAttempt, endAttempt,
  sanitizeConnectionIdentity, attachExecutionHeaders, finalizeExecutionState,
  newExecutionId,
} from "open-sse/services/executionReceipt.js";
import { finalizeExecution, recordExecutionUsage } from "@/lib/execution/receiptStore.js";

// Providers that don't require credentials (noAuth)
const NO_AUTH_PROVIDERS = new Set(["sdwebui", "comfyui"]);

export function finalizeImageFork(fork, result, apiKey) {
  if (!fork) return;
  const ok = !!(result && (result.ok === true || result.status === 200));
  // Close any attempt a throwing panel call left open.
  for (const a of fork.attempts) {
    if (a.status === "in_progress") {
      endAttempt(fork, a, { success: ok, status: result?.status || null, error: result?.message || result?.error || null });
    }
  }
  finalizeExecutionState(fork, ok
    ? { status: "success" }
    : { status: "error", error: { message: result?.message || result?.error || null, status_code: result?.status || null } });
  finalizeExecution(fork).catch(() => {});
  if (!fork.usageRecorded) {
    recordExecutionUsage(fork, {
      provider: fork.actual?.provider || null,
      model: fork.actual?.model || fork.requestedModel || null,
      connectionId: fork.actual?.connection?.id || null,
      apiKey: (result?.status === 401 || result?.status === 403) ? null : (apiKey || null),
      endpoint: fork.endpoint,
      status: ok ? "success" : "error",
      tokens: {},
    }).catch(() => {});
  }
}

/**
 * Handle image generation request
 */
export async function handleImageGeneration(request) {
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
    capability: "image",
    requestedModel: typeof body.model === "string" ? body.model : null,
    requestedProvider: (typeof body.model === "string" && body.model.includes("/"))
      ? body.model.slice(0, body.model.indexOf("/"))
      : null,
    heron,
    requestedParams: snapshotParams(body, { capability: "image" }),
  });

  try {
    let response;
    try {
      response = await handleImageWithExecution(request, body, execution);
    } catch (e) {
      if (execution.currentAttempt) endAttempt(execution, execution.currentAttempt, { success: false, status: HTTP_STATUS.BAD_GATEWAY, error: String(e?.message || e).slice(0, 500) });
      finalizeExecutionState(execution, { status: "error", error: { message: String(e?.message || e).slice(0, 500), status_code: HTTP_STATUS.BAD_GATEWAY } });
      if (!execution.usageRecorded) {
        recordExecutionUsage(execution, {
          provider: execution.actual?.provider || (typeof body.model === "string" && body.model.includes("/") ? body.model.slice(0, body.model.indexOf("/")) : null) || null,
          model: execution.actual?.model || (typeof body.model === "string" && body.model.includes("/") ? body.model.slice(body.model.indexOf("/") + 1) : body.model) || null,
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
    // Durable summary for failures AND for successes with no usage path.
    if (!execution.usageRecorded) {
      recordExecutionUsage(execution, {
        provider: execution.actual?.provider || (typeof body.model === "string" && body.model.includes("/") ? body.model.slice(0, body.model.indexOf("/")) : null) || null,
        model: execution.actual?.model || (typeof body.model === "string" && body.model.includes("/") ? body.model.slice(body.model.indexOf("/") + 1) : body.model) || null,
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

/**
 * Convert a single-model execution into a usage row (images have no token
 * counts — usage is counted per request) and capture the resolved cost state.
 */
async function recordImageUsage(execution, { provider, model, connectionId, apiKey, endpoint }) {
  await recordExecutionUsage(execution, {
    provider,
    model,
    connectionId,
    apiKey,
    endpoint: endpoint || "/v1/images/generations",
    status: "success",
    tokens: {},
  });
}

async function handleImageWithExecution(request, body, execution) {
  const url = new URL(request.url);
  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const wantsStream = (request.headers.get("accept") || "").includes("text/event-stream");
  const binaryOutput = url.searchParams.get("response_format") === "binary";
  const modelStr = body.model;

  const apiKey = extractApiKey(request);
  if (execution) execution.apiKeyMasked = apiKey ? log.maskKey(apiKey) : null;
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!body.prompt) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");

  // Combo expansion: model may be a combo name → run fallback/round-robin across models
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    setRouting(execution, { reason: `combo_${comboStrategy}`, requestedCombo: modelStr, candidates: comboModels });
    log.info("IMAGE", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m, isPanel) => {
        // Fusion panels run in parallel and each really executes upstream:
        // fork a linked sub-execution so N executions don't collide on one id.
        let subExecution = execution;
        if (isPanel) {
          subExecution = createExecution({
            endpoint: execution.endpoint,
            capability: execution.capability,
            executionId: newExecutionId(),
            parentExecutionId: execution.executionId,
            requestedModel: execution.requestedModel,
            requestedCombo: execution.requestedCombo || execution.requestedAlias || null,
            requestedProvider: execution.requestedProvider,
            heron: execution.heron ? { present: true, values: execution.heron, invalid: execution.heronInvalid || [] } : null,
            requestedParams: execution.requestedParams,
            apiKeyMasked: execution.apiKeyMasked,
          });
          setRouting(subExecution, { reason: "fusion_panel", requestedCombo: execution.requestedCombo || execution.requestedAlias || null, candidates: [m] });
        }
        const result = handleSingleModelImage(b, m, { wantsStream, binaryOutput, preferredConnectionId, apiKey, endpoint: url.pathname, execution: subExecution });
        if (subExecution !== execution) {
          const settled = Promise.resolve(result);
          settled.then((res) => finalizeImageFork(subExecution, res, apiKey)).catch((err) => finalizeImageFork(subExecution, err, apiKey));
        }
        return result;
      },
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
    });
  }

  return handleSingleModelImage(body, modelStr, { wantsStream, binaryOutput, preferredConnectionId, apiKey, endpoint: url.pathname, execution });
}

async function handleSingleModelImage(body, modelStr, { wantsStream, binaryOutput, preferredConnectionId, apiKey, endpoint, execution } = {}) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;
  if (execution) {
    setRouting(execution, { reason: execution.routingReason || "direct" });
    if (!execution.requestedCombo && !String(modelStr).includes("/") && modelStr !== model) {
      execution.requestedAlias = modelStr;
    }
  }

  // noAuth providers — no credential needed
  if (NO_AUTH_PROVIDERS.has(provider)) {
    const attempt = beginAttempt(execution, { candidate: modelStr, provider, model, reason: "primary" });
    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: null,
      binaryOutput,
      execution,
    });
    endAttempt(execution, attempt, { success: result.success, status: result.status, error: result.error });
    if (result.success) {
      await recordImageUsage(execution, { provider, model, connectionId: null, apiKey, endpoint });
      return result.response;
    }
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Image generation failed");
  }

  // Credentialed providers — fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { preferredConnectionId });

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
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      }
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    const attempt = beginAttempt(execution, {
      candidate: modelStr,
      provider,
      model,
      connection: sanitizeConnectionIdentity(credentials),
      reason: excludeConnectionIds.size > 0 ? "account_fallback" : "primary",
    });

    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      streamToClient: wantsStream,
      binaryOutput,
      execution,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      }
    });

    endAttempt(execution, attempt, { success: result.success, status: result.status, error: result.error });

    if (result.success) {
      await recordImageUsage(execution, { provider, model, connectionId: credentials.connectionId, apiKey, endpoint });
      return result.response;
    }

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);

    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}