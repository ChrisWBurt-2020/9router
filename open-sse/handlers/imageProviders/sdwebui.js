// SD WebUI (AUTOMATIC1111) — local, noAuth
import { nowSec } from "./_base.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";

const BASE_URL = PROVIDER_MEDIA["sdwebui"]?.imageConfig?.baseUrl;

const MODEL_ROLES = new Map([
  ["local-fast-image", "sdxl-lightning-4step"],
  ["local-quality-image", "sdxl-base-1.0"],
  ["local-edit-image", "sdxl-base-1.0"],
]);

export default {
  noAuth: true,
  buildUrl: () => BASE_URL,
  buildHeaders: () => ({ "Content-Type": "application/json" }),
  local: true,
  estimatedCostUsd: 0,
  resolveRole: (role) => MODEL_ROLES.get(String(role).toLowerCase()) || role,
  buildBody: (model, body) => {
    const { prompt, n = 1, size = "1024x1024" } = body;
    const [width, height] = size.split("x").map(Number);
    return {
      prompt, width: width || 512, height: height || 512,
      steps: Number(body.steps || 20), batch_size: n,
      cfg_scale: Number(body.cfg || 7),
      seed: body.seed === undefined ? -1 : Number(body.seed),
      override_settings: { sd_model_checkpoint: body.checkpoint || MODEL_ROLES.get(String(model).toLowerCase()) || model },
    };
  },
  normalize: (responseBody) => {
    const images = Array.isArray(responseBody.images) ? responseBody.images.map((img) => ({ b64_json: img })) : [];
    return { created: nowSec(), data: images };
  },
};
