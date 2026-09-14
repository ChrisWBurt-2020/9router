import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-exec-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function makeExecutionState() {
  const { createExecution, beginAttempt, endAttempt, recordActual, setRouting, setStreaming, recordUsage, recordCost } =
    await import("open-sse/services/executionReceipt.js");
  const execution = createExecution({
    endpoint: "/v1/chat/completions",
    capability: "chat",
    requestedModel: "gpt-4o",
    requestedCombo: "my-combo",
    heron: { present: true, values: { trace_id: "trace-abc", intent_id: "intent-1" }, invalid: [] },
    requestedParams: { model: "gpt-4o", seed: 42 },
    apiKeyMasked: "sk-1234***",
  });
  setRouting(execution, { reason: "combo_fallback", requestedCombo: "my-combo", candidates: ["a", "b"] });
  const a1 = beginAttempt(execution, { candidate: "a", provider: "openai", model: "gpt-4o", reason: "primary" });
  endAttempt(execution, a1, { success: false, status: 429, error: "rate limited" });
  const a2 = beginAttempt(execution, { candidate: "b", provider: "openrouter", model: "meta-llama/llama-3.3-70b", reason: "fallback" });
  endAttempt(execution, a2, { success: true, status: 200 });
  recordActual(execution, { provider: "openrouter", model: "meta-llama/llama-3.3-70b", connectionId: "conn-b", connectionLabel: "9router", authType: "apikey" });
  setStreaming(execution, true);
  recordUsage(execution, { prompt_tokens: 11, completion_tokens: 7 });
  // No manual cost: the resolver yields "unknown" for a no-pricing / no-token
  // basis, which is the truthful default for this isolated DB.
  return execution;
}

describe("execution receipt store (SQLite)", () => {
  it("migration v2 adds executionId/traceId columns and indexes", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const db = await getAdapter();
    expect(parseInt(db.get(`SELECT value FROM _meta WHERE key='schemaVersion'`).value, 10)).toBe(latestVersion());
    const cols = db.all(`PRAGMA table_info(usageHistory)`).map((r) => r.name);
    expect(cols).toEqual(expect.arrayContaining(["executionId", "traceId", "meta"]));
    const idx = db.all(`PRAGMA index_list(usageHistory)`).map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(["idx_uh_execution", "idx_uh_trace"]));
  });

  it("persists Heron metadata, costs state and lookup by execution_id / trace_id", async () => {
    const execution = await makeExecutionState();
    const { finalizeExecutionState, buildExecutionReceipt } = await import("open-sse/services/executionReceipt.js");
    finalizeExecutionState(execution, { status: "success" });

    const store = await import("@/lib/execution/receiptStore.js");
    const { finalizeExecution, recordExecutionUsage } = store;
    await finalizeExecution(execution);
    await recordExecutionUsage(execution, {
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b",
      connectionId: "conn-b",
      apiKey: "sk-1234-client-key",
      endpoint: "/v1/chat/completions",
      status: "success",
      tokens: { prompt_tokens: 11, completion_tokens: 7 },
    });

    // lookup by execution_id → detailed receipt
    const byId = await store.getExecutionById(execution.executionId);
    expect(byId).toBeTruthy();
    expect(byId.execution_id).toBe(execution.executionId);
    expect(byId.schema_version).toBe(1);
    expect(byId.heron).toEqual({ trace_id: "trace-abc", intent_id: "intent-1", work_id: null, world_id: null });
    expect(byId.routing.reason).toBe("combo_fallback");
    expect(byId.routing.requested_combo).toBe("my-combo");
    expect(byId.attempts.length).toBe(2);
    expect(byId.attempts.map((a) => a.status)).toEqual(["error", "success"]);
    expect(byId.actual.provider).toBe("openrouter");
    expect(byId.actual.model).toBe("meta-llama/llama-3.3-70b");
    expect(byId.receipt_source).toBe("request_details");

    // lookup by trace_id → summary + attached detailed receipt
    const byTrace = await store.getExecutionsByTraceId("trace-abc");
    expect(byTrace.length).toBe(1);
    expect(byTrace[0].heron.trace_id).toBe("trace-abc");
    expect(byTrace[0].routing_reason).toBe("combo_fallback");
    expect(byTrace[0].fallbacks).toBe(1);
    expect(byTrace[0].receipt).toBeTruthy();
    expect(byTrace[0].cost.state).toBe("unknown");
  });

  it("does not persist secrets in either usageHistory or requestDetails", async () => {
    const execution = await makeExecutionState();
    const { finalizeExecutionState } = await import("open-sse/services/executionReceipt.js");
    finalizeExecutionState(execution, { status: "success" });
    const { finalizeExecution, recordExecutionUsage } = await import("@/lib/execution/receiptStore.js");
    await finalizeExecution(execution);
    await recordExecutionUsage(execution, {
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b",
      connectionId: "conn-b",
      apiKey: "sk-1234-client-key",
      endpoint: "/v1/chat/completions",
      status: "success",
      tokens: {},
    });

    const { getAdapter } = await import("@/lib/db/driver.js");
    const { flushRequestDetails } = await import("@/lib/db/index.js");
    await flushRequestDetails();
    const db = await getAdapter();
    const usage = db.all(`SELECT * FROM usageHistory`)[0];
    const details = db.all(`SELECT * FROM requestDetails`)[0];
    expect(details).toBeTruthy();
    expect(JSON.stringify(usage.meta)).not.toContain("sk-1234-client-key");
    expect(JSON.stringify(details.data)).not.toContain("sk-1234-client-key");
    expect(JSON.stringify(details.data)).not.toContain("refreshToken");
  });

  it("unknown cost is not misreported as free in the DB summary", async () => {
    const execution = await makeExecutionState();
    const { finalizeExecutionState } = await import("open-sse/services/executionReceipt.js");
    finalizeExecutionState(execution, { status: "success" });
    const { finalizeExecution, recordExecutionUsage } = await import("@/lib/execution/receiptStore.js");
    await finalizeExecution(execution);
    await recordExecutionUsage(execution, {
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b",
      connectionId: "conn-b",
      apiKey: null,
      endpoint: "/v1/chat/completions",
      status: "success",
      tokens: {},
    });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const usage = db.all(`SELECT * FROM usageHistory`)[0];
    const meta = JSON.parse(usage.meta);
    expect(meta.cost_state).toBe("unknown");
    expect(usage.cost).toBe(0); // numeric column stays 0, state disambiguates
  });

  it("completeExecution supersedes a provisional receipt (streaming path)", async () => {
    const execution = await makeExecutionState();
    const { finalizeExecutionState } = await import("open-sse/services/executionReceipt.js");
    finalizeExecutionState(execution, { status: "streaming" });
    const store = await import("@/lib/execution/receiptStore.js");
    await store.finalizeExecution(execution);
    expect((await store.getExecutionById(execution.executionId)).status).toBe("streaming");
    await store.completeExecution(execution, {
      status: "success",
      usage: { prompt_tokens: 5, completion_tokens: 3 },
      latency: { total_ms: 12, ttft_ms: 4, upstream_ms: 9 },
      endedAt: Date.now(),
    });
    const done = await store.getExecutionById(execution.executionId);
    expect(done.status).toBe("success");
    expect(done.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 3 });
    expect(done.latency.total_ms).toBe(12);
  });

  it("trace lookup finds failed executions that never wrote a usage row", async () => {
    // A failed chat request records a detailed receipt but no usageHistory row
    // (usage only persists on success). Trace lookup must still find it.
    const { createExecution, finalizeExecutionState, beginAttempt, endAttempt, recordActual } = await import("open-sse/services/executionReceipt.js");
    const execution = createExecution({
      endpoint: "/v1/chat/completions",
      capability: "chat",
      requestedModel: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      heron: { present: true, values: { trace_id: "trace-failed-1" }, invalid: [] },
    });
    const a = beginAttempt(execution, { candidate: "openrouter/meta-llama/llama-3.3-70b-instruct:free", provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free", reason: "primary" });
    endAttempt(execution, a, { success: false, status: 404, error: "model unavailable" });
    recordActual(execution, { provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free", connectionId: "c-1", connectionLabel: "9router", authType: "apikey" });
    finalizeExecutionState(execution, { status: "error" });

    const store = await import("@/lib/execution/receiptStore.js");
    await store.finalizeExecution(execution); // no recordExecutionUsage on purpose

    const byTrace = await store.getExecutionsByTraceId("trace-failed-1");
    expect(byTrace.length).toBe(1);
    expect(byTrace[0].status).toBe("error");
    expect(byTrace[0].receipt_detail).toBe(true);
    expect(byTrace[0].receipt).toBeTruthy();
    expect(byTrace[0].receipt.attempts[0].status).toBe("error");
  });

  it("failed-execution durable summary keeps lookup working after requestDetails pruning", async () => {
    // What the wrapper does for a failed request: receipt + durable error
    // summary in usageHistory. Simulate requestDetails FIFO pruning (delete the
    // detail row) — the execution must remain findable via the summary.
    const { createExecution, finalizeExecutionState, beginAttempt, endAttempt, recordActual } = await import("open-sse/services/executionReceipt.js");
    const execution = createExecution({
      endpoint: "/v1/chat/completions",
      capability: "chat",
      requestedModel: "openrouter/x",
      heron: { present: true, values: { trace_id: "trace-pruned-1" }, invalid: [] },
    });
    const a = beginAttempt(execution, { candidate: "openrouter/x", provider: "openrouter", model: "x", reason: "primary" });
    endAttempt(execution, a, { success: false, status: 503, error: "upstream down" });
    recordActual(execution, { provider: "openrouter", model: "x", connectionId: "c-1", connectionLabel: "9router", authType: "apikey" });
    finalizeExecutionState(execution, { status: "error" });

    const store = await import("@/lib/execution/receiptStore.js");
    await store.finalizeExecution(execution);
    await store.recordExecutionUsage(execution, {
      provider: "openrouter", model: "x", connectionId: "c-1", apiKey: null,
      endpoint: "/v1/chat/completions", status: "error", tokens: {},
    });
    expect(execution.usageRecorded).toBe(true);

    // Simulate the requestDetails FIFO cap pruning the detail row. Flush any
    // buffered writes FIRST so the delete is not resurrected by the next flush.
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { flushRequestDetails } = await import("@/lib/db/index.js");
    await flushRequestDetails();
    const db = await getAdapter();
    db.run(`DELETE FROM requestDetails WHERE id = ?`, [execution.executionId]);

    const byId = await store.getExecutionById(execution.executionId);
    expect(byId).toBeTruthy();
    expect(byId.execution_id).toBe(execution.executionId);
    expect(byId.status).toBe("error");
    expect(byId.receipt_source).toBe("usage_history");
    expect(byId.receipt_detail).toBe(false);

    const byTrace = await store.getExecutionsByTraceId("trace-pruned-1");
    expect(byTrace.length).toBe(1);
    expect(byTrace[0].status).toBe("error");
  });

  it("aborted streams get a durable usageHistory summary; double-write guard holds", async () => {
    const { createExecution, finalizeExecutionState, beginAttempt, endAttempt, recordActual } = await import("open-sse/services/executionReceipt.js");
    const execution = createExecution({
      endpoint: "/v1/chat/completions",
      capability: "chat",
      requestedModel: "openrouter/x",
      heron: { present: true, values: { trace_id: "trace-abort-1" }, invalid: [] },
    });
    const a = beginAttempt(execution, { candidate: "openrouter/x", provider: "openrouter", model: "x", reason: "primary" });
    endAttempt(execution, a, { success: true, status: 200 });
    recordActual(execution, { provider: "openrouter", model: "x", connectionId: "c-1", connectionLabel: "9router", authType: "apikey" });

    const store = await import("@/lib/execution/receiptStore.js");
    const { completeExecution, recordExecutionUsage } = store;

    // client disconnects mid-stream: chatCore's onDisconnect path
    finalizeExecutionState(execution, { status: "aborted" });
    await recordExecutionUsage(execution, {
      provider: "openrouter", model: "x", connectionId: "c-1", apiKey: null,
      endpoint: "/v1/chat/completions", status: "aborted", tokens: {},
    });
    await completeExecution(execution, { status: "aborted", error: "client disconnected", endedAt: Date.now() });
    expect(execution.usageRecorded).toBe(true);

    // After the guard, a second durable write is a no-op (no double row).
    const again = await recordExecutionUsage(execution, {
      provider: "openrouter", model: "x", connectionId: "c-1", apiKey: null,
      endpoint: "/v1/chat/completions", status: "error", tokens: {},
    });
    expect(again).toBeNull();
    const { getUsageRecordsByTraceId } = await import("@/lib/db/index.js");
    const rows = await getUsageRecordsByTraceId("trace-abort-1");
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("aborted");

    const byId = await store.getExecutionById(execution.executionId);
    expect(byId.status).toBe("aborted");
  });

  it("same-millisecond executions with distinct ids both get durable rows (dedupe collision)", async () => {
    const { createExecution, finalizeExecutionState } = await import("open-sse/services/executionReceipt.js");
    const store = await import("@/lib/execution/receiptStore.js");
    const sharedTs = new Date().toISOString();

    const e1 = createExecution({ endpoint: "/v1/chat/completions", capability: "chat", requestedModel: "m", requestedParams: { model: "m" } });
    const e2 = createExecution({ endpoint: "/v1/chat/completions", capability: "chat", requestedModel: "m", requestedParams: { model: "m" } });
    finalizeExecutionState(e1, { status: "success" });
    finalizeExecutionState(e2, { status: "success" });

    const opts = { provider: "openrouter", model: "m", connectionId: "c1", apiKey: null, endpoint: "/v1/chat/completions", status: "success", tokens: { prompt_tokens: 1, completion_tokens: 1 } };
    // Force identical timestamps by monkeypatching Date (both saves share timestamp).
    const realToISO = Date.prototype.toISOString;
    Date.prototype.toISOString = function () { return sharedTs; };
    try {
      await store.recordExecutionUsage(e1, { ...opts });
      await store.recordExecutionUsage(e2, { ...opts });
    } finally {
      Date.prototype.toISOString = realToISO;
    }

    const byId1 = await store.getExecutionById(e1.executionId);
    const byId2 = await store.getExecutionById(e2.executionId);
    expect(byId1).toBeTruthy();
    expect(byId2).toBeTruthy();
    expect(byId1.execution_id).toBe(e1.executionId);
    expect(byId2.execution_id).toBe(e2.executionId);
    // Both have their own durable rows keyed by their own executionId.
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const rows = db.all(`SELECT executionId FROM usageHistory WHERE executionId IN (?, ?)`, [e1.executionId, e2.executionId]);
    expect(rows.length).toBe(2);
  });
});
