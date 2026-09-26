/**
 * Free-tier model ids — the invariant that keeps a free-tier combo from ever
 * silently substituting a paid model.
 *
 * Enforcement is id-based and offline. The policy boundary is selected by the
 * resolved combo row (`kind === "free-tier"`); this module only classifies
 * candidates after that boundary has been entered. Ordinary models and
 * ordinary combos never consult this predicate for routing.
 *
 * Keep this catalog explicit rather than trusting a naming suffix. Unknown
 * pricing fails closed while evaluating a free-tier candidate, but remains
 * routable in ordinary policy contexts.
 *
 * Last audited 2026-09-26 against the live OpenRouter catalog. Removed:
 * nex-agi/nex-n2.5-pro:free, mistralai/devstral-2512:free,
 * moonshotai/kimi-k2.6:free, qwen/qwen3-coder:free, qwen/qwen3.6-plus:free
 * (all delisted or no longer zero-cost).
 */

export const FREE_MODEL_ALIASES = new Set(["openrouter/free"]);

// Generated/curated from the local provider catalog. Every entry is asserted
// to be zero-cost before it is admitted to a free-tier combo seed.
export const FREE_MODEL_CATALOG = new Set([
  "openrouter/cohere/north-mini-code:free",
  "openrouter/nvidia/nemotron-3.5-lightning:free",
  "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
  "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
  "openrouter/poolside/laguna-s-2.1:free",
  "openrouter/poolside/laguna-xs-2.1:free",
  "openrouter/qwen/qwen3.8-27b:free",
  "openrouter/google/gemma-4-31b-it:free",
  "openrouter/liquid/lfm-2.5-2.6b:free",
]);

export function isFreeModelId(modelId) {
  if (typeof modelId !== "string") return false;
  const id = modelId.trim().toLowerCase();
  if (!id) return false;
  if (FREE_MODEL_ALIASES.has(id)) return true;
  return FREE_MODEL_CATALOG.has(id);
}
