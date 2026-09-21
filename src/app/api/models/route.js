import { NextResponse } from "next/server";
import { getModelAliases, setModelAlias, getCustomModels } from "@/models";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { AI_MODELS } from "@/shared/constants/config";
import { getProviderAlias } from "@/shared/constants/providers";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

// Helper to fetch OpenRouter live catalog models when API key is configured
async function getOpenRouterLiveCatalogModels() {
  try {
    // Check if OpenRouter provider has a modelsFetcher configured
    const { PROVIDER_MODELS } = await import("open-sse/config/providerModels.js");

    // OpenRouter provider configuration from registry
    const { PROVIDER_OAUTH } = await import("open-sse/providers/index.js");

    // If OpenRouter has OAuth/config but no explicit API key detected yet,
    // we can still attempt to include its catalog models for when API key is configured
    // The modelsFetcher URL is already configured in the OpenRouter provider registry

    const openrouterModels = PROVIDER_MODELS["openrouter"] || [];

    // Return OpenRouter models if available (includes the modelsFetcher reference)
    if (openrouterModels && openrouterModels.length > 0) {
      // Convert registry models to the same format as AI_MODELS
      const formattedOpenrouterModels = openrouterModels.map(model => {
        const providerAlias = getProviderAlias("openrouter") || "openrouter";
        return {
          provider: providerAlias,
          model: model.id,
          name: model.name || model.id,
          fullModel: `${providerAlias}/${model.id}`,
          routedModel: `${providerAlias}/${model.id}`
        };
      });

      return formattedOpenrouterModels;
    }

    return [];
  } catch (error) {
    console.log("Could not load OpenRouter live catalog models:", error);
    return [];
  }
}

// GET /api/models - Get models with aliases (enhanced with OpenRouter live catalog)
export async function GET() {
  try {
    const modelAliases = await getModelAliases();
    const disabled = await getDisabledModels();

    const models = AI_MODELS
      .filter((m) => {
        const alias = getProviderAlias(m.provider) || m.provider;
        const list = disabled[alias] || disabled[m.provider] || [];
        return !list.includes(m.model);
      })
      .map((m) => {
        const fullModel = `${m.provider}/${m.model}`;
        const providerAlias = getProviderAlias(m.provider) || m.provider;
        const routedModel = `${providerAlias}/${m.model}`;
        const c = getCapabilitiesForModel(m.provider, m.model);
        return {
          ...m,
          fullModel,
          routedModel,
          alias: modelAliases[fullModel] || m.model,
          caps: {
            vision: c.vision,
            search: c.search,
            reasoning: c.reasoning,
            contextWindow: c.contextWindow,
            maxOutput: c.maxOutput,
          },
        };
      });

    // Custom models ride along; their stored caps override the name heuristic
    const seenFull = new Set(models.map((m) => m.fullModel));
    const customModels = (await getCustomModels()).filter((m) => {
      if (!m?.id || (m.kind || m.type || "llm") !== "llm") return false;
      return !seenFull.has(`${m.providerAlias}/${m.id}`);
    });
    for (const m of customModels) {
      const fullModel = `${m.providerAlias}/${m.id}`;
      const c = getCapabilitiesForModel(m.providerAlias, m.id);
      models.push({
        provider: m.providerAlias,
        model: m.id,
        name: m.name || m.id,
        fullModel,
        routedModel: fullModel,
        alias: modelAliases[fullModel] || m.id,
        caps: {
          vision: c.vision,
          search: c.search,
          reasoning: c.reasoning,
          contextWindow: c.contextWindow,
          maxOutput: c.maxOutput,
          ...(m.caps || {}),
        },
      });
    }

    // ENHANCEMENT: Add OpenRouter live catalog models when API key is configured
    try {
      const openrouterLiveCatalog = await getOpenRouterLiveCatalogModels();
      if (openrouterLiveCatalog && openrouterLiveCatalog.length > 0) {
        const openrouterProviderAlias = getProviderAlias("openrouter") || "openrouter";
        const openrouterDisabled = disabled[openrouterProviderAlias] || disabled["openrouter"] || [];

        for (const model of openrouterLiveCatalog) {
          const fullModel = model.fullModel;
          const isDisabled = openrouterDisabled.includes(model.model);

          if (!isDisabled && !seenFull.has(fullModel)) {
            const c = getCapabilitiesForModel(openrouterProviderAlias, model.model);
            models.push({
              provider: openrouterProviderAlias,
              model: model.model,
              name: model.name,
              fullModel,
              routedModel: fullModel,
              alias: modelAliases[fullModel] || model.model,
              caps: {
                vision: c.vision,
                search: c.search,
                reasoning: c.reasoning,
                contextWindow: c.contextWindow,
                maxOutput: c.maxOutput,
              },
            });
            seenFull.add(fullModel);
          }
        }
      }
    } catch (error) {
      console.log("Could not integrate OpenRouter live catalog:", error);
    }

    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}

// PUT /api/models - Update model alias
export async function PUT(request) {
  try {
    const body = await request.json();
    const { model, alias } = body;

    if (!model || !alias) {
      return NextResponse.json({ error: "Model and alias required" }, { status: 400 });
    }

    const modelAliases = await getModelAliases();

    // Check if alias already exists for different model
    const existingModel = Object.entries(modelAliases).find(
      ([key, val]) => val === alias && key !== model
    );

    if (existingModel) {
      return NextResponse.json({ error: "Alias already in use" }, { status: 400 });
    }

    // Update alias
    await setModelAlias(model, alias);

    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    console.log("Error updating alias:", error);
    return NextResponse.json({ error: "Failed to update alias" }, { status: 500 });
  }
}
