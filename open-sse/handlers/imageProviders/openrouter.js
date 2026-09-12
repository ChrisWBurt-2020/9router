// OpenRouter's dedicated Images API is similar to OpenAI's shape, but it has
// native resolution/aspect/reference/provider-routing fields and returns
// media_type alongside b64_json. Keep it separate from the generic adapter so
// OpenAI-compatible providers do not receive fields they do not understand.
import { PROVIDER_MEDIA } from "../../providers/index.js";

const imageCfg = PROVIDER_MEDIA.openrouter?.imageConfig || {};

const IMAGE_FIELDS = [
  "n",
  "resolution",
  "aspect_ratio",
  "size",
  "quality",
  "style",
  "output_format",
  "background",
  "output_compression",
  "seed",
  "input_references",
  "provider",
];

const DEFAULT_PROVIDER = { sort: "price", allow_fallbacks: true };

function aspectRatioFromSize(size) {
  if (typeof size !== "string") return null;
  const match = size.trim().match(/^(\d+)x(\d+)$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return null;

  const legacyAliases = {
    "1024x1024": "1:1",
    "1792x1024": "16:9",
    "1024x1792": "9:16",
    "1536x1024": "3:2",
    "1024x1536": "2:3",
  };
  if (legacyAliases[`${width}x${height}`]) return legacyAliases[`${width}x${height}`];

  // Reduce arbitrary pixel dimensions, preserving OpenRouter's familiar ratio
  // spelling for common storybook layouts.
  const gcd = (a, b) => {
    while (b) [a, b] = [b, a % b];
    return a;
  };
  const divisor = gcd(width, height);
  const ratio = `${width / divisor}:${height / divisor}`;
  const aliases = {
    "1:1": "1:1",
    "4:3": "4:3",
    "3:4": "3:4",
    "3:2": "3:2",
    "2:3": "2:3",
    "16:9": "16:9",
    "9:16": "9:16",
  };
  return aliases[ratio] || ratio;
}

function validateReferences(references) {
  if (references === undefined) return undefined;
  if (!Array.isArray(references)) throw new Error("input_references must be an array");
  if (references.length > 16) throw new Error("input_references supports at most 16 images");

  return references.map((reference, index) => {
    const url = reference?.image_url?.url;
    if (reference?.type !== "image_url" || typeof url !== "string" || !url) {
      throw new Error(`input_references[${index}] must be an image_url reference`);
    }
    if (!/^https?:\/\//i.test(url) && !/^data:image\/[a-z0-9.+-]+;base64,/i.test(url)) {
      throw new Error(`input_references[${index}] must use an https URL or image data URL`);
    }
    return { type: "image_url", image_url: { url } };
  });
}

function normalizeProvider(provider) {
  if (provider === undefined) return { ...DEFAULT_PROVIDER };
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    throw new Error("provider must be an object");
  }
  return { ...DEFAULT_PROVIDER, ...provider };
}

export default {
  buildUrl: () => imageCfg.baseUrl,

  buildHeaders: (credentials) => {
    const headers = {
      "Content-Type": "application/json",
      ...(imageCfg.headers || {}),
    };
    const key = credentials?.apiKey || credentials?.accessToken;
    if (key) headers.Authorization = `Bearer ${key}`;
    return headers;
  },

  buildBody: (model, body) => {
    if (!body || typeof body !== "object") throw new Error("Image request body must be an object");
    if (!body.prompt) throw new Error("Missing required field: prompt");

    const request = { model, prompt: body.prompt, n: body.n === undefined ? 1 : body.n };
    for (const field of IMAGE_FIELDS) {
      if (body[field] !== undefined) request[field] = body[field];
    }

    if (request.aspect_ratio === undefined && request.size !== undefined) {
      const derived = aspectRatioFromSize(request.size);
      if (derived) request.aspect_ratio = derived;
    }

    if (String(request.output_format || "").toLowerCase() === "jpg") {
      request.output_format = "jpeg";
    }

    const references = validateReferences(request.input_references);
    if (references !== undefined) request.input_references = references;
    request.provider = normalizeProvider(request.provider);

    // Some OpenAI clients use response_format as a codec hint. OpenRouter's
    // Images API calls the equivalent field output_format; url/b64_json are
    // response encodings and must not be sent upstream.
    if (!request.output_format && ["png", "jpeg", "jpg", "webp", "svg"].includes(String(body.response_format || "").toLowerCase())) {
      request.output_format = String(body.response_format).toLowerCase() === "jpg" ? "jpeg" : String(body.response_format).toLowerCase();
    }

    return request;
  },

  normalize: (responseBody) => responseBody,
};
