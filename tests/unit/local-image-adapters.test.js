import { describe, it, expect, vi, afterEach } from "vitest";
import { getImageAdapter } from "../../open-sse/handlers/imageProviders/index.js";

describe("local image adapters", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("builds a ComfyUI SDXL Lightning workflow and normalizes downloaded history", async () => {
    const adapter = getImageAdapter("comfyui");
    expect(adapter.local).toBe(true);
    expect(adapter.estimatedCostUsd).toBe(0);
    const request = adapter.buildBody("sdxl-lightning-4step", { prompt: "a heron", size: "1024x768", seed: 7 });
    expect(request.prompt["7"].inputs.steps).toBe(4);
    expect(request.prompt["7"].inputs.seed).toBe(7);
    expect(request.prompt["6"].inputs.width).toBe(1024);

    const discovered = adapter.buildBody("comfyui/actual-checkpoint.safetensors", { prompt: "a heron" });
    expect(discovered.prompt["3"].inputs.ckpt_name).toBe("actual-checkpoint.safetensors");

    vi.useFakeTimers();
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ "job-1": { outputs: {
        "9": { images: [{ filename: "heron.png", subfolder: "", type: "output" }] },
      } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(Buffer.from("png-bytes"), { status: 200 }));
    const pending = adapter.parseResponse({ json: async () => ({ prompt_id: "job-1" }) });
    await vi.advanceTimersByTimeAsync(1500);
    const result = await pending;
    expect(result.data[0].b64_json).toBe(Buffer.from("png-bytes").toString("base64"));
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("normalizes SDWebUI output and carries local zero-cost metadata", () => {
    const adapter = getImageAdapter("sdwebui");
    expect(adapter.local).toBe(true);
    expect(adapter.estimatedCostUsd).toBe(0);
    const body = adapter.buildBody("sdxl-lightning-4step", { prompt: "a heron", size: "768x512", n: 2, seed: 11 });
    expect(body.width).toBe(768);
    expect(body.height).toBe(512);
    expect(body.seed).toBe(11);
    expect(adapter.normalize({ images: ["a", "b"] }).data).toHaveLength(2);
  });
});
