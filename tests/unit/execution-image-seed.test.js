import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { createExecution, finalizeExecutionState, buildExecutionReceipt } from "../../open-sse/services/executionReceipt.js";

const originalFetch = global.fetch;

vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    execute: async ({ model, body }) => ({
      response: {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: "cG5n" } }] } }] }),
      },
      url: "https://executor.test",
      headers: {},
      transformedBody: body,
    }),
  }),
}));

function mockExecution({ seed }) {
  const execution = createExecution({
    endpoint: "/v1/images/generations",
    capability: "image",
    requestedModel: "bytedance-seed/seedream-5-0-lite",
    requestedParams: { model: "bytedance-seed/seedream-5-0-lite", seed },
  });
  return execution;
}

function okImageResponse() {
  return new Response(
    JSON.stringify({ created: 1234567890, data: [{ b64_json: "cG5n", media_type: "image/png" }] }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("image seed compatibility truth (execution receipt)", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("records seed_applied=true when the upstream accepts the seed", async () => {
    global.fetch.mockResolvedValueOnce(okImageResponse());

    const execution = mockExecution({ seed: 1234 });
    const result = await handleImageGenerationCore({
      body: { prompt: "A heron at dawn", size: "1024x768", seed: 1234 },
      modelInfo: { provider: "openrouter", model: "bytedance-seed/seedream-5-0-lite" },
      credentials: { apiKey: "test-key" },
      log: null,
      execution,
    });
    expect(result.success).toBe(true);
    finalizeExecutionState(execution, { status: "success" });
    const receipt = buildExecutionReceipt(execution);
    expect(receipt.determinism).toEqual({ seed_requested: 1234, seed_applied: true, determinism_honored: true });
    // No seed mutation; other requested→effective mappings (size etc.) may exist.
    expect(receipt.compatibility_mutations.find((m) => m.field === "seed")).toBeUndefined();

    // The upstream request actually carried the seed.
    const sentBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sentBody.seed).toBe(1234);
  });

  it("records the compatibility mutation and seed_applied=false when a 400 drops the seed", async () => {
    // First attempt: 400 "seed not supported"; second attempt: success without seed.
    global.fetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "seed parameter not supported" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(okImageResponse());

    const execution = mockExecution({ seed: 1234 });
    const result = await handleImageGenerationCore({
      body: { prompt: "A heron at dawn", size: "1024x768", seed: 1234 },
      modelInfo: { provider: "openrouter", model: "bytedance-seed/seedream-5-0-lite" },
      credentials: { apiKey: "test-key" },
      log: null,
      execution,
    });
    expect(result.success).toBe(true);

    // The mutated retry genuinely omitted the seed.
    const firstBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    const retryBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(firstBody.seed).toBe(1234);
    expect(retryBody.seed).toBeUndefined();

    finalizeExecutionState(execution, { status: "success" });
    const receipt = buildExecutionReceipt(execution);
    expect(receipt.determinism).toEqual({ seed_requested: 1234, seed_applied: false, determinism_honored: false });
    const mutation = receipt.compatibility_mutations.find((m) => m.field === "seed");
    expect(mutation).toEqual(expect.objectContaining({
      action: "removed",
      reason: "upstream_rejected_parameter",
      requested_value: 1234,
      effective_value: null,
      determinism_honored: false,
    }));
    expect(receipt.request.effective_params.seed).toBeNull();
  });

  it("records the mutation when the adapter drops the seed at build time", async () => {
    // Use sdwebui, whose adapter does not forward `seed` — request stays intact.
    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ images: ["cG5n"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const execution = mockExecution({ seed: 99 });
    const result = await handleImageGenerationCore({
      body: { prompt: "A tree", size: "768x768", seed: 99 },
      modelInfo: { provider: "sdwebui", model: "sdxl-base-1.0" },
      credentials: null,
      log: null,
      execution,
    });
    expect(result.success).toBe(true);
    const sentBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sentBody.seed).toBeUndefined();
    finalizeExecutionState(execution, { status: "success" });
    const receipt = buildExecutionReceipt(execution);
    expect(receipt.determinism.seed_applied).toBe(false);
    expect(receipt.compatibility_mutations.find((m) => m.field === "seed").action).toBe("removed");
  });

  it("keeps binary output compatible while carrying execution identity headers", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ created: 1, data: [{ b64_json: "cG5n", media_type: "image/png" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const execution = mockExecution({ seed: undefined });
    const result = await handleImageGenerationCore({
      body: { prompt: "An icon", output_format: "png" },
      modelInfo: { provider: "openrouter", model: "recraft/recraft-v4.1-vector" },
      credentials: { apiKey: "test-key" },
      binaryOutput: true,
      log: null,
      execution,
    });
    expect(result.success).toBe(true);
    expect(result.response.headers.get("Content-Type")).toBe("image/png");
    const wrapped = (await import("../../open-sse/services/executionReceipt.js")).attachExecutionHeaders(result.response, execution);
    expect(wrapped.headers.get("Content-Type")).toBe("image/png");
    expect(wrapped.headers.get("X-9Router-Execution-Id")).toBe(execution.executionId);
    const bytes = Buffer.from(await wrapped.arrayBuffer());
    expect(bytes.toString("base64")).toBe("cG5n");
  });

  it("does NOT claim seed_applied for executor-delegated adapters that drop the seed", async () => {
    // The antigravity adapter builds its own envelope from prompt/image/size and
    // never forwards body.seed — the receipt must say so (regression for C4).
    const execution = mockExecution({ seed: 55 });
    const result = await handleImageGenerationCore({
      body: { prompt: "A heron", size: "1024x1024", seed: 55 },
      modelInfo: { provider: "antigravity", model: "gemini-3.1-flash-image" },
      credentials: { accessToken: "tok", connectionName: "Acct", authType: "oauth" },
      log: null,
      execution,
    });
    expect(result.success).toBe(true);
    finalizeExecutionState(execution, { status: "success" });
    const receipt = buildExecutionReceipt(execution);
    expect(receipt.determinism.seed_applied).toBe(false);
    expect(receipt.determinism.determinism_honored).toBe(false);
    const mutation = receipt.compatibility_mutations.find((m) => m.field === "seed");
    expect(mutation).toEqual(expect.objectContaining({
      action: "removed",
      reason: "adapter_dropped_seed",
      requested_value: 55,
      effective_value: null,
    }));
  });
});
