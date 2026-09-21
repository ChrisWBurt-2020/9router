// ComfyUI — local, noAuth.  The adapter accepts an explicit workflow graph
// when callers need a custom pipeline and otherwise submits a small SDXL
// Lightning graph suitable for the Heron Press local baseline.
import { nowSec, sleep, POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from "./_base.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";

const BASE_URL = PROVIDER_MEDIA["comfyui"]?.imageConfig?.baseUrl;

// Stable internal roles sit underneath the existing public model IDs. The
// legacy IDs remain valid compatibility aliases, while discovered checkpoint
// filenames continue to pass through unchanged.
const CHECKPOINT_ROLES = new Map([
  ["local-fast-image", "sdxl_lightning_4step.safetensors"],
  ["local-quality-image", "sdxl_lightning_4step.safetensors"],
  ["local-edit-image", "sdxl_lightning_4step.safetensors"],
  ["sdxl-lightning-4step", "sdxl_lightning_4step.safetensors"],
  ["flux-dev", "flux1-dev-fp8.safetensors"],
]);

function dimensions(body) {
  const size = String(body?.size || "1024x1024").match(/^(\d+)x(\d+)$/);
  return { width: Number(size?.[1] || 1024), height: Number(size?.[2] || 1024) };
}

function defaultWorkflow(model, body) {
  const { width, height } = dimensions(body);
  // Catalog IDs are namespaced for Heron/9Router, while ComfyUI expects the
  // exact checkpoint filename returned by its live catalog.
  const selected = body.checkpoint || model || process.env.COMFYUI_CHECKPOINT || "sdxl_lightning_4step.safetensors";
  const selectedId = String(selected).replace(/^comfyui\//i, "");
  const checkpoint = CHECKPOINT_ROLES.get(selectedId.toLowerCase()) || selectedId;
  const steps = Number(body.steps || 4);
  return {
    "3": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: body.prompt, clip: ["3", 1] } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: body.negative_prompt || "text, watermark, blurry", clip: ["3", 1] } },
    "6": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: Number(body.n || 1) } },
    "7": { class_type: "KSampler", inputs: { seed: body.seed === undefined || body.seed === null ? Math.floor(Math.random() * 2 ** 31) : Number(body.seed), steps, cfg: Number(body.cfg || 1), sampler_name: body.sampler_name || "euler", scheduler: body.scheduler || "sgm_uniform", denoise: 1, model: ["3", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0] } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: body.filename_prefix || "heron-press", images: ["8", 0] } },
  };
}

function normalizeHistory(history) {
  const images = [];
  for (const node of Object.values(history?.outputs || {})) {
    for (const image of node?.images || []) {
      const params = new URLSearchParams({ filename: image.filename || "", subfolder: image.subfolder || "", type: image.type || "output" });
      images.push({ url: `${BASE_URL}/view?${params.toString()}`, media_type: "image/png" });
    }
  }
  return images;
}

export default {
  noAuth: true,
  buildUrl: () => `${BASE_URL}/prompt`,
  buildHeaders: () => ({ "Content-Type": "application/json" }),
  local: true,
  estimatedCostUsd: 0,
  resolveRole: (role) => CHECKPOINT_ROLES.get(String(role).toLowerCase()) || role,
  buildBody: (model, body) => ({ prompt: body.workflow || defaultWorkflow(model, body), client_id: body.client_id || "heron-press" }),
  getExecutionTruth: (requestBody) => {
    const prompt = requestBody?.prompt;
    const sampler = prompt?.["7"]?.inputs;
    const checkpoint = prompt?.["3"]?.inputs?.ckpt_name;
    return {
      seed: sampler?.seed,
      checkpoint,
      workflow_family: checkpoint && /flux/i.test(String(checkpoint)) ? "flux" : "sdxl-k_sampler",
    };
  },
  async parseResponse(response) {
    const accepted = await response.json();
    const promptId = accepted?.prompt_id;
    if (!promptId) throw new Error("ComfyUI did not return prompt_id");
    const deadline = Date.now() + Number(process.env.COMFYUI_POLL_TIMEOUT_MS || POLL_TIMEOUT_MS);
    while (Date.now() < deadline) {
      await sleep(Number(process.env.COMFYUI_POLL_INTERVAL_MS || POLL_INTERVAL_MS));
      const historyResponse = await fetch(`${BASE_URL}/history/${encodeURIComponent(promptId)}`);
      if (!historyResponse.ok) throw new Error(`ComfyUI history returned ${historyResponse.status}`);
      const history = await historyResponse.json();
      const entry = history?.[promptId] || history;
      if (entry?.status?.status_str === "error" || entry?.status?.completed === false && entry?.status?.messages?.some?.((message) => message?.[0] === "execution_error")) {
        throw new Error("ComfyUI workflow failed");
      }
      const images = normalizeHistory(entry);
      if (images.length) {
        const data = [];
        for (const image of images) {
          const imageResponse = await fetch(image.url);
          if (!imageResponse.ok) throw new Error(`ComfyUI image download returned ${imageResponse.status}`);
          data.push({ b64_json: Buffer.from(await imageResponse.arrayBuffer()).toString("base64"), media_type: image.media_type });
        }
        return { created: nowSec(), data };
      }
    }
    throw new Error("ComfyUI workflow polling timed out");
  },
  normalize: (responseBody) => responseBody?.created && Array.isArray(responseBody?.data)
    ? responseBody
    : { created: nowSec(), data: responseBody?.data || [] },
};
