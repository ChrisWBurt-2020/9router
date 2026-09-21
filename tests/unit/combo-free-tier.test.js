import { describe, it, expect, vi } from "vitest";

import { handleComboChat, handleFusionChat, isFreeModelId } from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

// Minimal OpenAI-chat Response stub with the .ok + .status + .statusText +
// .clone().json() surface the engine uses.
function okResponse(content) {
  const json = { choices: [{ message: { role: "assistant", content } }] };
  const make = () => ({ ok: true, status: 200, statusText: "OK", clone: make, json: async () => json });
  return make();
}

function rateLimitResponse(status = 429) {
  const make = () => ({
    ok: false, status, statusText: "Too Many Requests",
    clone: make, json: async () => ({ error: { message: "Rate limit exceeded" } }),
  });
  return make();
}

describe("isFreeModelId", () => {
  it("accepts only exact catalog entries, case-insensitively", () => {
    expect(isFreeModelId("openrouter/qwen/qwen3.6-plus:free")).toBe(true);
    expect(isFreeModelId("openrouter/nex-agi/nex-n2.5-pro:free")).toBe(true);
    expect(isFreeModelId("openrouter/poolside/laguna-s-2.1:free")).toBe(true);
    expect(isFreeModelId("OPENROUTER/QWEN/QWEN3.6-PLUS:FREE")).toBe(true);
  });

  it("whitelists the openrouter/free catch-all gateway even without a suffix", () => {
    expect(isFreeModelId("openrouter/free")).toBe(true);
    expect(isFreeModelId("  openrouter/free  ")).toBe(true);
  });

  it("rejects paid ids, near-miss suffixes, and non-strings", () => {
    expect(isFreeModelId("openrouter/deepseek/deepseek-v4.1-flash")).toBe(false);
    expect(isFreeModelId("openai/gpt-4o")).toBe(false);
    expect(isFreeModelId("some-new-provider/new-model:free")).toBe(false); // unknown pricing fails closed in free-tier policy
    expect(isFreeModelId("my-free-model")).toBe(false);
    expect(isFreeModelId(null)).toBe(false);
    expect(isFreeModelId(undefined)).toBe(false);
    expect(isFreeModelId("")).toBe(false);
    expect(isFreeModelId(42)).toBe(false);
  });

  it("does not decide whether an ordinary combo is routable", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => okResponse(`ok-${model}`));
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["new-provider/new-model:free", "openai/gpt-4o"],
      handleSingleModel,
      log,
      comboName: "ordinary-combo",
      comboStrategy: "fallback",
    });

    expect(res.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledWith(expect.anything(), "new-provider/new-model:free");
  });
});

describe("handleComboChat freeTierOnly", () => {
  it("never calls handleSingleModel with a paid model, and succeeds on the free one", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => okResponse(`ans-${model}`));
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["openai/gpt-4o", "openrouter/qwen/qwen3.6-plus:free"],
      handleSingleModel,
      log,
      comboName: "gov-build",
      comboStrategy: "fallback",
      freeTierOnly: true,
    });

    expect(res.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel.mock.calls[0][1]).toBe("openrouter/qwen/qwen3.6-plus:free");
  });

  it("filters a capacity-adapter-style paid addition injected mid-list", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free") return rateLimitResponse(429);
      return okResponse("ok");
    });
    await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", "openrouter/deepseek/deepseek-v4.1-flash", "openrouter/free"],
      handleSingleModel,
      log,
      comboName: "gov-emergency",
      comboStrategy: "fallback",
      freeTierOnly: true,
    });
    const tried = handleSingleModel.mock.calls.map(([, m]) => m);
    expect(tried).toEqual(["openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", "openrouter/free"]);
  });

  it("returns 503 without calling any model when every candidate is paid", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("should never run"));
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["openai/gpt-4o", "openrouter/deepseek/deepseek-v4.1-flash"],
      handleSingleModel,
      log,
      comboName: "gov-emergency",
      comboStrategy: "fallback",
      freeTierOnly: true,
    });

    expect(res.status).toBe(503);
    expect(handleSingleModel).not.toHaveBeenCalled();
    const data = await res.json();
    expect(data.error.message).toContain("free-tier only");
  });

  it("still fails over between free models on rate limits (none paid ever tried)", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "openrouter/qwen/qwen3-coder:free") return rateLimitResponse(429);
      return okResponse("recovered");
    });
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["openrouter/qwen/qwen3-coder:free", "openrouter/nex-agi/nex-n2.5-pro:free"],
      handleSingleModel,
      log,
      comboName: "gov-build",
      comboStrategy: "fallback",
      freeTierOnly: true,
    });

    expect(res.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    const tried = handleSingleModel.mock.calls.map(([, m]) => m);
    expect(tried).toEqual(["openrouter/qwen/qwen3-coder:free", "openrouter/nex-agi/nex-n2.5-pro:free"]);
  });

  it("keeps prior behaviour when freeTierOnly is not set (paid models still tried)", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "openai/gpt-4o") return rateLimitResponse(429);
      return okResponse("fallback success");
    });
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["openai/gpt-4o", "openrouter/deepseek/deepseek-v4.1-flash"],
      handleSingleModel,
      log,
      comboName: "legacy-combo",
      comboStrategy: "fallback",
    });

    expect(res.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(handleSingleModel.mock.calls[0][1]).toBe("openai/gpt-4o");
  });
});

describe("handleFusionChat freeTierOnly", () => {
  it("drops paid panel members and replaces a paid judge with a free panel model", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => okResponse(`answer from ${model}`));
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: [
        "openai/gpt-4o",
        "openrouter/qwen/qwen3.6-plus:free",
        "openrouter/nex-agi/nex-n2.5-pro:free",
      ],
      handleSingleModel,
      log,
      comboName: "gov-review",
      judgeModel: "openai/gpt-4o",
      freeTierOnly: true,
    });

    expect(res.status).toBe(200);
    const tried = handleSingleModel.mock.calls.map(([, m]) => m);
    expect(tried.every(isFreeModelId)).toBe(true);
    expect(tried).not.toContain("openai/gpt-4o");
    expect(handleSingleModel).toHaveBeenCalledWith(
      expect.anything(),
      "openrouter/qwen/qwen3.6-plus:free",
      true
    );
    // No explicit free judge -> panel[0], reused as the synthesis call (2-arg, no isPanel).
    expect(handleSingleModel.mock.calls.at(-1)[1]).toBe("openrouter/qwen/qwen3.6-plus:free");
    expect(handleSingleModel.mock.calls.at(-1)[2]).toBeUndefined();
  });

  it("returns 503 without calling any model when every panel member is paid", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("should never run"));
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["openai/gpt-4o", "anthropic/claude-3-opus"],
      handleSingleModel,
      log,
      comboName: "gov-review",
      freeTierOnly: true,
    });

    expect(res.status).toBe(503);
    expect(handleSingleModel).not.toHaveBeenCalled();
    const data = await res.json();
    expect(data.error.message).toContain("free-tier only");
  });

  it("filters down to a single free model and answers directly without a judge", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => okResponse(`answer from ${model}`));
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["openai/gpt-4o", "openrouter/free"],
      handleSingleModel,
      log,
      comboName: "gov-fast",
      freeTierOnly: true,
    });

    expect(res.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel.mock.calls[0][1]).toBe("openrouter/free");
    expect(handleSingleModel.mock.calls[0][2]).toBeUndefined();
  });

  it("keeps routing a paid judge when freeTierOnly is not set", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => okResponse(`answer from ${model}`));
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["openrouter/qwen/qwen3.6-plus:free", "openrouter/nex-agi/nex-n2.5-pro:free"],
      handleSingleModel,
      log,
      comboName: "legacy-fusion",
      judgeModel: "openai/gpt-4o",
    });

    const tried = handleSingleModel.mock.calls.map(([, m]) => m);
    expect(tried).toContain("openai/gpt-4o");
    expect(handleSingleModel.mock.calls.at(-1)[1]).toBe("openai/gpt-4o");
  });
});
