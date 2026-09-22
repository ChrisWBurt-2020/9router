import { buildExecutionReceipt, buildUsageMeta, recordLatency, recordUsage, recordCost, finalizeExecutionState } from "open-sse/services/executionReceipt.js";
import { reportSpendToGovernor, spendReportFromExecution } from "../spendGate.js";
import {
  saveRequestDetail, getRequestDetailById, flushRequestDetails,
  getUsageRecordByExecutionId, getUsageRecordsByTraceId, getRecentExecutions,
  getReceiptsByTraceId,
  saveRequestUsage,
} from "@/lib/usageDb.js";

/**
 * Execution receipt store.
 *
 * Two persistence surfaces, both pre-existing:
 *  - usageHistory (always on): compact summary in `meta` + indexed
 *    executionId/traceId columns — durable lookup without observability.
 *  - requestDetails (receipt-only records always persisted): the detailed
 *    receipt under `data.receipt`, keyed by the execution_id itself.
 *
 * Fail-open: persistence must never break an inference request. The outcome
 * is still recorded in memory and exposed through response headers/metrics.
 */

const receiptPersistenceHealth = { persisted: 0, degraded: 0, failed: 0 };

export function getReceiptPersistenceHealth() {
  return { ...receiptPersistenceHealth };
}

export async function finalizeExecution(execution) {
  if (!execution) return null;
  try {
    // Build the durable payload with the success state. If the write throws,
    // the catch below changes only in-memory state because no receipt exists
    // to update.
    execution.evidenceStatus = "persisted";
    const receipt = buildExecutionReceipt(execution);
    await saveRequestDetail({
      id: execution.executionId,
      timestamp: execution.startedAt,
      provider: receipt.actual?.provider || receipt.request?.provider || null,
      model: receipt.actual?.model || receipt.request?.model || null,
      connectionId: receipt.actual?.connection?.id || null,
      status: receipt.status,
      receiptOnly: true,
      receipt,
    });
    execution.receiptPersisted = true;
    receiptPersistenceHealth.persisted += 1;
    return receipt;
  } catch (error) {
    execution.receiptPersisted = false;
    execution.evidenceStatus = "failed";
    receiptPersistenceHealth.failed += 1;
    // This is deliberately a warning rather than a thrown request error: the
    // inference result remains valid, but evidence durability is degraded.
    console.warn?.(`[9router] receipt persistence failed for ${execution.executionId}: ${error?.message || error}`);
    return null;
  }
}

/**
 * Apply the terminal facts to an execution and persist its receipt. Safe to
 * call more than once on the same execution (later call wins via UPSERT) — the
 * streaming provisional call is superseded by the completion call.
 */
export async function completeExecution(execution, {
  status = "success",
  error = null,
  latency = null,
  usage = null,
  cost = null,
  costState = null,
  endedAt = Date.now(),
} = {}) {
  if (!execution) return null;
  if (latency) recordLatency(execution, latency);
  if (usage) recordUsage(execution, usage);
  if (cost !== null && cost !== undefined) recordCost(execution, cost, costState);
  finalizeExecutionState(execution, { status, error, endedAt });
  return finalizeExecution(execution);
}

/**
 * Record a non-chat execution (image/audio) in usageHistory with its compact
 * execution summary, and capture the resolved cost state on the execution.
 */
export async function recordExecutionUsage(execution, {
  provider, model, connectionId = null, apiKey = null, endpoint = null,
  status = "success", tokens = {},
} = {}) {
  if (execution?.usageRecorded) return null; // already durable elsewhere — no double writes
  try {
    const meta = buildUsageMeta(execution);
    const res = await saveRequestUsage({
      provider,
      model,
      connectionId,
      apiKey,
      endpoint,
      status,
      tokens,
      executionId: execution?.executionId || null,
      traceId: execution?.heron?.trace_id || null,
      meta: meta ? { ...meta, status } : {},
    });
    if (execution) execution.usageRecorded = true;
    if (res && execution) {
      // Only let a *known* resolution drive the execution's cost; an "unknown"
      // resolver result (e.g. image calls have no token basis) must never
      // overwrite a cost the execution already recorded truthfully.
      if (res.costState && res.costState !== "unknown") {
        recordCost(execution, res.cost, res.costState);
      }
      if (tokens && Object.keys(tokens).length) recordUsage(execution, tokens);
    }
    // Spend gate: feed actuals to governor's ledger hook so it can track
    // effective cost per consumer/model/provider. Best-effort and never
    // throwing; no-op unless GOVERNOR_BASE_URL is set.
    try {
      reportSpendToGovernor(spendReportFromExecution(execution, {
        status,
        tokens,
        costUsd: res && res.cost != null ? res.cost : null,
      }));
    } catch { /* the ledger hook must never break usage persistence */ }
    return res;
  } catch {
    if (execution) {
      execution.evidenceStatus = "failed";
      receiptPersistenceHealth.failed += 1;
      console.warn?.(`[9router] usage persistence failed for ${execution.executionId}`);
    }
    return null;
  }
}

function summaryFromUsageRow(row) {
  if (!row) return null;
  const meta = row.meta && typeof row.meta === "object" ? row.meta : {};
  return {
    schema_version: meta.schema_version ?? null,
    execution_id: row.executionId || meta.execution_id || null,
    parent_execution_id: meta.parent_execution_id || null,
    heron: meta.heron || null,
    timestamp: row.timestamp,
    endpoint: row.endpoint,
    status: meta.status || row.status || null,
    requested: meta.requested || { model: row.model, alias_or_combo: null, provider: row.provider },
    actual: meta.actual || (row.provider || row.model ? { provider: row.provider, model: row.model } : null),
    routing_reason: meta.routing_reason || null,
    attempts: meta.attempts ?? null,
    fallbacks: meta.fallbacks ?? null,
    compatibility_mutations: meta.compatibility_mutations || [],
    determinism: meta.determinism || null,
    cost: {
      amount: typeof row.cost === "number" ? row.cost : 0,
      currency: "USD",
      state: meta.cost_state || "unknown",
    },
    usage: row.tokens || null,
    streamed: meta.streamed ?? null,
    receipt_source: "usage_history",
    receipt_detail: false,
  };
}

/**
 * Fetch one execution by execution_id. Prefers the detailed receipt in
 * requestDetails; falls back to the always-present usageHistory summary.
 */
export async function getExecutionById(executionId) {
  if (!executionId) return null;
  try { await flushRequestDetails(); } catch { /* lookup must not fail on flush */ }
  try {
    const detail = await getRequestDetailById(executionId);
    if (detail?.receipt) {
      return { ...detail.receipt, receipt_source: "request_details", receipt_detail: true };
    }
  } catch { /* fall through to summary */ }

  const usage = await getUsageRecordByExecutionId(executionId);
  return summaryFromUsageRow(usage);
}

/**
 * Recent executions sharing a Heron trace_id, newest first. Merges the durable
 * usageHistory summaries with detailed receipts from requestDetails — the
 * latter are what catch failed/aborted executions that never wrote a usage row.
 */
export async function getExecutionsByTraceId(traceId, limit = 20) {
  if (!traceId) return [];
  try { await flushRequestDetails(); } catch { /* lookup must not fail on flush */ }

  let rows = [];
  try { rows = await getUsageRecordsByTraceId(traceId, limit); } catch { return []; }

  // Detailed receipts (may include executions with no usage row).
  let detailReceipts = [];
  try { detailReceipts = await getReceiptsByTraceId(traceId, limit); } catch { /* summaries only */ }
  const detailByExec = new Map();
  for (const r of detailReceipts) if (r?.execution_id) detailByExec.set(r.execution_id, r);

  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const summary = summaryFromUsageRow(row);
    if (!summary || !summary.execution_id) continue;
    seen.add(summary.execution_id);
    if (detailByExec.has(summary.execution_id)) {
      summary.receipt = detailByExec.get(summary.execution_id);
      summary.receipt_detail = true;
    }
    out.push(summary);
  }
  for (const r of detailReceipts) {
    if (!r?.execution_id || seen.has(r.execution_id)) continue;
    out.push({
      execution_id: r.execution_id,
      schema_version: r.schema_version,
      heron: r.heron,
      timestamp: r.started_at,
      status: r.status,
      requested: r.request,
      actual: r.actual,
      routing_reason: r.routing?.reason,
      attempts: r.attempts?.length,
      fallbacks: r.routing?.fallback_count,
      cost: r.cost,
      usage: r.usage,
      receipt_source: "request_details",
      receipt_detail: true,
      receipt: r,
    });
  }

  return out
    .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))
    .slice(0, Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100));
}

export async function listRecentExecutions(limit = 20) {
  try {
    const rows = await getRecentExecutions(limit);
    return rows.map(summaryFromUsageRow).filter(Boolean);
  } catch {
    return [];
  }
}

export const __test__ = { summaryFromUsageRow };
