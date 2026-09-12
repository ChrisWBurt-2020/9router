import { describe, expect, it } from "vitest";
import { PROVIDER_MEDIA, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getImageAdapter } from "../../open-sse/handlers/imageProviders/index.js";

describe("OpenRouter image catalog", () => {
  it("exposes the curated current models as image services", () => {
    const models = PROVIDER_MODELS.openrouter || [];
    const ids = models.filter((model) => model.kind === "image").map((model) => model.id);
    expect(PROVIDER_MEDIA.openrouter.serviceKinds).toContain("image");
    expect(ids).toEqual(expect.arrayContaining([
      "bytedance-seed/seedream-5-0-lite",
      "google/gemini-3.1-flash-lite-image",
      "black-forest-labs/flux.2-klein-4b",
      "sourceful/riverflow-v2.5-fast",
      "recraft/recraft-v4.1-vector",
    ]));
  });

  it("keeps legacy image IDs and targets the dedicated upstream path", () => {
    const ids = (PROVIDER_MODELS.openrouter || []).map((model) => model.id);
    expect(ids).toEqual(expect.arrayContaining([
      "openai/dall-e-3",
      "openai/gpt-image-1",
      "google/imagen-3.0-generate-002",
      "black-forest-labs/FLUX.1-schnell",
    ]));
    expect(getImageAdapter("openrouter").buildUrl()).toBe("https://openrouter.ai/api/v1/images");
  });
});
