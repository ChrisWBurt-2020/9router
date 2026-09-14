import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  extractApiKey: vi.fn(),
  isValidApiKey: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
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
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: mocks.updateProviderCredentials,
  checkAndRefreshToken: mocks.checkAndRefreshToken,
}));
vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  maskKey: (k) => (k ? k.slice(0, 4) + "***" : null),
}));
vi.mock("@/lib/execution/receiptStore.js", () => ({
  finalizeExecution: mocks.finalizeExecution,
  recordExecutionUsage: mocks.recordExecutionUsage,
}));

import { handleImageGeneration } from "@/sse/handlers/imageGeneration.js";
import { buildExecutionReceipt } from "open-sse/services/executionReceipt.js";

function imageRequest(body) {
  return new Request("http://router.test/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Heron-Trace-Id": "tr-img-throw" },
    body: JSON.stringify(body),
  });
}

describe("image handler exception paths (execution receipts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.extractApiKey.mockReturnValue("client-key");
    mocks.finalizeExecution.mockResolvedValue(undefined);
    mocks.recordExecutionUsage.mockResolvedValue(undefined);
  });

  it("a routing-layer throw still yields a terminal error receipt + durable summary", async () => {
    mocks.getModelInfo.mockRejectedValue(new Error("model resolution boom"));

    const res = await handleImageGeneration(imageRequest({ model: "openai/dall-e-3", prompt: "heron" }));
    expect(res.status).toBe(502);
    expect(res.headers.get("X-9Router-Execution-Id")).toMatch(/^9r_exec_/);

    const [executionArg] = mocks.finalizeExecution.mock.calls[0] || [];
    expect(executionArg).toBeTruthy();
    const receipt = buildExecutionReceipt(executionArg);
    expect(receipt.status).toBe("error");
    expect(receipt.error.status_code).toBe(502);
    expect(mocks.recordExecutionUsage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "error" }));
  });
});