import {
  extractApiKey, isValidApiKey,
  getProviderCredentials, markAccountUnavailable,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { handleSttCore } from "open-sse/handlers/sttCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import * as log from "../utils/logger.js";
import {
  createExecution, extractHeronCorrelation, stripHeronMetadata,
  snapshotParams, setRouting, beginAttempt, endAttempt,
  sanitizeConnectionIdentity, attachExecutionHeaders, finalizeExecutionState,
} from "open-sse/services/executionReceipt.js";
import { finalizeExecution, recordExecutionUsage } from "@/lib/execution/receiptStore.js";

// Providers requiring credentials for STT
const CREDENTIALED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.serviceKinds?.includes("stt") && !p.noAuth && p.sttConfig?.authType !== "none")
    .map(([id]) => id)
);

export async function handleStt(request) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart form data");
  }

  const url = new URL(request.url);
  const modelStr = formData.get("model");
  log.request("POST", `/v1/audio/transcriptions | ${modelStr}`);

  // Heron correlation via headers only (multipart has no JSON `metadata`).
  const heron = extractHeronCorrelation({ headers: Object.fromEntries(request.headers.entries()) });

  const execution = createExecution({
    endpoint: url.pathname,
    capability: "stt",
    requestedModel: typeof modelStr === "string" ? modelStr : null,
    requestedProvider: (typeof modelStr === "string" && modelStr.includes("/"))
      ? modelStr.slice(0, modelStr.indexOf("/"))
      : null,
    heron,
    requestedParams: snapshotParams(
      { model: modelStr, language: formData.get("language") || undefined, response_format: formData.get("response_format") || undefined },
      { capability: "stt" }
    ),
  });

  try {
    let response;
    try {
      response = await handleSttWithExecution(request, formData, modelStr, execution);
    } catch (e) {
      if (execution.currentAttempt) endAttempt(execution, execution.currentAttempt, { success: false, status: HTTP_STATUS.BAD_GATEWAY, error: String(e?.message || e).slice(0, 500) });
      finalizeExecutionState(execution, { status: "error", error: { message: String(e?.message || e).slice(0, 500), status_code: HTTP_STATUS.BAD_GATEWAY } });
      if (!execution.usageRecorded) {
        recordExecutionUsage(execution, {
          provider: execution.actual?.provider || null,
          model: execution.actual?.model || (typeof modelStr === "string" ? modelStr : null),
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
        model: execution.actual?.model || (typeof modelStr === "string" ? modelStr : null),
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

async function handleSttWithExecution(request, formData, modelStr, execution) {
  const settings = await getSettings();
  const apiKey = extractApiKey(request);
  if (execution) execution.apiKeyMasked = apiKey ? log.maskKey(apiKey) : null;
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!formData.get("file")) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: file");

  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;
  if (execution) {
    setRouting(execution, { reason: "direct" });
    if (!String(modelStr).includes("/") && modelStr !== model) execution.requestedAlias = modelStr;
  }
  log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);

  // noAuth providers
  if (!CREDENTIALED_PROVIDERS.has(provider)) {
    const attempt = beginAttempt(execution, { candidate: modelStr, provider, model, reason: "primary" });
    const result = await handleSttCore({ provider, model, formData, sttConfig: AI_PROVIDERS[provider]?.sttConfig });
    endAttempt(execution, attempt, { success: result.success, status: result.status, error: result.error });
    if (result.success) {
      await recordExecutionUsage(execution, {
        provider, model, connectionId: null, apiKey: null, endpoint: "/v1/audio/transcriptions", status: "success", tokens: {},
      });
      return result.response;
    }
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "STT failed");
  }

  // Credentialed — fallback loop
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

    const result = await handleSttCore({ provider, model, formData, credentials, sttConfig: AI_PROVIDERS[provider]?.sttConfig });
    endAttempt(execution, attempt, { success: result.success, status: result.status, error: result.error });

    if (result.success) {
      await recordExecutionUsage(execution, {
        provider,
        model,
        connectionId: credentials.connectionId,
        apiKey,
        endpoint: "/v1/audio/transcriptions",
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