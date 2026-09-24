import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  extractApiKey: vi.fn(),
  isValidApiKey: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  getModelInfo: vi.fn(),
  getComboByName: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
  handleChatCore: vi.fn(),
  finalizeExecution: vi.fn(),
  recordExecutionUsage: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getComboByName: mocks.getComboByName,
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: mocks.updateProviderCredentials,
  checkAndRefreshToken: mocks.checkAndRefreshToken,
}));
vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  maskKey: (k) => (k ? k.slice(0, 4) + "***" : null), line: vi.fn(), nextTag: () => "T",
  tagForSession: () => "T",
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: mocks.handleChatCore,
}));
vi.mock("@/lib/execution/receiptStore.js", () => ({
  finalizeExecution: mocks.finalizeExecution,
  recordExecutionUsage: mocks.recordExecutionUsage,
}));

import { handleChat } from "@/sse/handlers/chat.js";
import { buildExecutionReceipt } from "open-sse/services/executionReceipt.js";

function chatRequest(body, headers = {}) {
  return new Request("http://router.test/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const successChatResponse = () =>
  new Response(JSON.stringify({ id: "chatcmpl-1", choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("execution receipts through the chat handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: false, comboStrategy: "fallback" });
    mocks.extractApiKey.mockReturnValue("client-key");
    mocks.checkAndRefreshToken.mockImplementation(async (_p, creds) => creds);
    mocks.updateProviderCredentials.mockResolvedValue(undefined);
    mocks.finalizeExecution.mockResolvedValue(undefined);
    mocks.recordExecutionUsage.mockResolvedValue(undefined);
    mocks.getModelInfo.mockImplementation(async (m) => {
      if (String(m).includes("/")) {
        const slash = String(m).indexOf("/");
        return { provider: String(m).slice(0, slash), model: String(m).slice(slash + 1) };
      }
      return { provider: "openai", model: String(m) };
    });
    // Mimic the bits of chatCore that touch the execution context.
    mocks.handleChatCore.mockImplementation(async (opts) => {
      const { recordActual, setStreaming } = await import("open-sse/services/executionReceipt.js");
      recordActual(opts.execution, {
        provider: opts.modelInfo.provider,
        model: opts.modelInfo.model,
        connectionId: opts.connectionId || null,
        connectionLabel: opts.credentials?.connectionName || null,
        authType: opts.credentials?.authType || null,
      });
      setStreaming(opts.execution, false);
      return { success: true, response: successChatResponse() };
    });
  });

  it("Heron metadata grants NO authorization (missing key still 401)", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.extractApiKey.mockReturnValue(null);
    mocks.isValidApiKey.mockResolvedValue(false);

    const res = await handleChat(
      chatRequest(
        { model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] },
        { "X-Heron-Trace-Id": "tr-attacker", "X-Heron-World-Id": "world-attacker" }
      )
    );
    expect(res.status).toBe(401);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
    const [executionArg] = mocks.finalizeExecution.mock.calls[0] || [];
    if (executionArg) {
      const receipt = buildExecutionReceipt(executionArg);
      expect(receipt.status).toBe("error");
      expect(receipt.heron?.trace_id).toBe("tr-attacker"); // recorded, not trusted
    }
    // An auth-rejected summary must NOT persist the supplied Authorization value.
    const usageCalls = mocks.recordExecutionUsage.mock.calls.filter((c) => c[1]);
    expect(usageCalls.length).toBeGreaterThan(0);
    for (const [, record] of usageCalls) {
      expect(record.apiKey).toBeNull();
    }
  });

  it("Heron metadata survives request → execution, is echoed, and is not forwarded upstream", async () => {
    mocks.getProviderCredentials.mockResolvedValue({
      connectionId: "conn-1",
      connectionName: "Primary",
      authType: "apikey",
    });
    let capturedExecution = null;
    mocks.handleChatCore.mockImplementation(async (opts) => {
      capturedExecution = opts.execution;
      expect(opts.body.metadata).not.toHaveProperty("heron_trace_id");
      expect(opts.body.metadata).toEqual({ user: "keep" });
      const { recordActual, setStreaming } = await import("open-sse/services/executionReceipt.js");
      recordActual(opts.execution, { provider: "openai", model: "gpt-4o", connectionId: "conn-1", connectionLabel: "Primary", authType: "apikey" });
      setStreaming(opts.execution, false);
      return { success: true, response: successChatResponse() };
    });

    const res = await handleChat(
      chatRequest(
        {
          model: "openai/gpt-4o",
          messages: [{ role: "user", content: "hi" }],
          metadata: { heron_trace_id: "tr-live-1", heron_intent_id: "int-7", heron_consumer: "homenode-voice", user: "keep" },
        },
        { "X-Heron-World-Id": "world-9" }
      )
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-9Router-Execution-Id")).toMatch(/^9r_exec_/);
    expect(res.headers.get("X-Heron-Trace-Id")).toBe("tr-live-1");
    expect(capturedExecution.heron).toEqual({ trace_id: "tr-live-1", intent_id: "int-7", world_id: "world-9", consumer: "homenode-voice" });

    const receipt = buildExecutionReceipt(capturedExecution);
    expect(receipt.heron.trace_id).toBe("tr-live-1");
    expect(receipt.request.model).toBe("openai/gpt-4o");
    expect(receipt.actual).toEqual({
      provider: "openai",
      model: "gpt-4o",
      connection: { id: "conn-1", label: "Primary", auth_type: "apikey" },
    });
    expect(receipt.status).toBe("success");
  });

  it("account fallback preserves ordered attempts; combo name preserved", async () => {
    mocks.getComboByName.mockResolvedValue({
      models: ["openai/gpt-4o", "openrouter/meta-llama/llama-3.3-70b"],
      kind: null,
    });
    mocks.getProviderCredentials.mockResolvedValue({
      connectionId: "conn-1",
      connectionName: "Primary",
      authType: "apikey",
    });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });

    let call = 0;
    let capturedExecution = null;
    mocks.handleChatCore.mockImplementation(async (opts) => {
      capturedExecution = opts.execution;
      call += 1;
      const { recordActual, setStreaming } = await import("open-sse/services/executionReceipt.js");
      recordActual(opts.execution, { provider: opts.modelInfo.provider, model: opts.modelInfo.model, connectionId: "conn-1", connectionLabel: "Primary", authType: "apikey" });
      setStreaming(opts.execution, false);
      if (call === 1) {
        return { success: false, status: 429, error: "rate limited", response: new Response("{}", { status: 429 }) };
      }
      return { success: true, response: successChatResponse() };
    });

    const res = await handleChat(
      chatRequest({ model: "combo-a", messages: [{ role: "user", content: "hi" }], metadata: { heron_trace_id: "tr-combo", heron_consumer: "homenode-voice" } })
    );

    expect(res.status).toBe(200);
    const receipt = buildExecutionReceipt(capturedExecution);
    expect(receipt.routing.requested_combo).toBe("combo-a");
    expect(receipt.routing.reason).toBe("combo_fallback");
    expect(receipt.attempts.map((a) => a.candidate)).toEqual([
      "openai/gpt-4o",
      "openrouter/meta-llama/llama-3.3-70b",
    ]);
    expect(receipt.attempts[0].status).toBe("error");
    expect(receipt.attempts[1].status).toBe("success");
    expect(receipt.actual.model).toBe("meta-llama/llama-3.3-70b");
    expect(receipt.request.model).toBe("combo-a");
  });

  it("single-model combo path reuses getModelInfo's combo row (one lookup) and enforces freeTierOnly", async () => {
    // Top-level combo resolution misses, so the request falls through to
    // handleSingleModelChat, whose getModelInfo resolves the combo row instead.
    mocks.getComboByName.mockResolvedValue(undefined);
    mocks.getModelInfo.mockImplementation(async (m) => {
      if (m === "gov-build") {
        return {
          provider: null,
          model: "gov-build",
          combo: { kind: "free-tier", models: ["openai/gpt-4o", "openrouter/qwen/qwen3.6-plus:free"] },
        };
      }
      const s = String(m);
      if (s.includes("/")) {
        const slash = s.indexOf("/");
        return { provider: s.slice(0, slash), model: s.slice(slash + 1) };
      }
      return { provider: "openai", model: s };
    });
    mocks.getProviderCredentials.mockResolvedValue({
      connectionId: "conn-1",
      connectionName: "Primary",
      authType: "apikey",
    });

    const res = await handleChat(
      chatRequest({ model: "gov-build", messages: [{ role: "user", content: "hi" }] })
    );

    expect(res.status).toBe(200);
    // Fix: the row came back from getModelInfo — no second getComboByName.
    expect(mocks.getComboByName).toHaveBeenCalledTimes(1);
    // Fix: the paid panel member was filtered before any upstream call.
    const attempted = mocks.handleChatCore.mock.calls.map((c) => c[0].modelInfo.model);
    expect(attempted).toEqual(["qwen/qwen3.6-plus:free"]);
    expect(attempted).not.toContain("gpt-4o");
  });

  it("fusion panels fork linked sub-executions with distinct ids (no id collision)", async () => {
    const { createExecution, newExecutionId } = await import("open-sse/services/executionReceipt.js");
    // Direct unit on the fork plumbing: two forks must get distinct ids linked
    // to the parent, with correlation preserved.
    const parent = createExecution({
      endpoint: "/v1/chat/completions",
      capability: "chat",
      requestedModel: "combo-fusion",
      heron: { present: true, values: { trace_id: "tr-1" }, invalid: [] },
    });
    const { forkComboExecution } = await import("@/sse/handlers/chat.js");
    const f1 = forkComboExecution(parent, { candidate: "openai/gpt-4o" });
    const f2 = forkComboExecution(parent, { candidate: "openrouter/meta-llama/llama-3.3-70b" });
    expect(f1.executionId).not.toBe(f2.executionId);
    expect(f1.parentExecutionId).toBe(parent.executionId);
    expect(f2.parentExecutionId).toBe(parent.executionId);
    expect(f1.heron).toEqual(parent.heron);
    expect(typeof newExecutionId()).toBe("string");
  });

  it("fusion panel rejection leaves no in_progress attempt on the fork", async () => {
    const { createExecution, beginAttempt, buildExecutionReceipt } = await import("open-sse/services/executionReceipt.js");
    const { finalizeForkedExecution } = await import("@/sse/handlers/chat.js");

    const fork = createExecution({
      endpoint: "/v1/chat/completions",
      capability: "chat",
      requestedModel: "openai/gpt-4o",
      executionId: "fork-1",
      parentExecutionId: "parent-1",
      heron: { present: true, values: { trace_id: "tr-fork" }, invalid: [] },
    });
    beginAttempt(fork, { candidate: "openai/gpt-4o", provider: "openai", model: "gpt-4o", reason: "fusion_panel" });

    finalizeForkedExecution(fork, new Error("panel boom"), { apiKey: "k" });

    const receipt = buildExecutionReceipt(fork);
    expect(receipt.status).toBe("error");
    expect(receipt.attempts[0].status).toBe("error"); // closed, not in_progress
    expect(mocks.finalizeExecution).toHaveBeenCalledWith(fork);
    expect(mocks.recordExecutionUsage).toHaveBeenCalledWith(fork, expect.objectContaining({ status: "error" }));
  });

  it("a rejected fusion panel (401) never persists the supplied key", async () => {
    const { createExecution, beginAttempt } = await import("open-sse/services/executionReceipt.js");
    const { finalizeForkedExecution } = await import("@/sse/handlers/chat.js");

    const fork = createExecution({
      endpoint: "/v1/chat/completions",
      capability: "chat",
      requestedModel: "openai/gpt-4o",
      executionId: "fork-401",
      parentExecutionId: "parent-1",
    });
    beginAttempt(fork, { candidate: "openai/gpt-4o", provider: "openai", model: "gpt-4o", reason: "fusion_panel" });

    // Panel upstream returned 401 (e.g. revoked token / failed refresh).
    finalizeForkedExecution(fork, { ok: false, status: 401, message: "unauthorized" }, { apiKey: "super-secret-key" });

    const usageCalls = mocks.recordExecutionUsage.mock.calls.filter((c) => c[1]);
    expect(usageCalls.length).toBeGreaterThan(0);
    for (const [, record] of usageCalls) {
      expect(record.apiKey).toBeNull();
    }
    expect(mocks.recordExecutionUsage).toHaveBeenCalledWith(
      fork,
      expect.objectContaining({ status: "error", apiKey: null })
    );
  });

  it("wrapper throws still produce a terminal error receipt + durable summary", async () => {
    mocks.getProviderCredentials.mockResolvedValue({
      connectionId: "conn-1",
      connectionName: "Primary",
      authType: "apikey",
    });
    mocks.handleChatCore.mockRejectedValue(new Error("routing boom"));

    const res = await handleChat(
      chatRequest({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] })
    );
    // Routed errors may surface as a combo-converted 5xx or the wrapper 502 —
    // either way the receipt/durable summary must be terminal + error.
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.headers.get("X-9Router-Execution-Id")).toMatch(/^9r_exec_/);

    const [executionArg] = mocks.finalizeExecution.mock.calls[0] || [];
    const receipt = buildExecutionReceipt(executionArg);
    expect(receipt.status).toBe("error");
    expect(receipt.error.status_code).toBe(res.status);
    // Every attempt is closed — never left "in_progress".
    for (const a of receipt.attempts) {
      expect(["success", "error"]).toContain(a.status);
    }
    // The durable summary write is attempted for the failure.
    expect(mocks.recordExecutionUsage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "error" }));
  });
});