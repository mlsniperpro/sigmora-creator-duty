import type { AppConfig } from "../config.js";
import { DeterministicModelAgent } from "./deterministic.js";
import { ModelAgentError } from "./errors.js";
import { GemmaCriticAdapter } from "./gemma.js";
import { GeminiModelAgent } from "./gemini.js";
import type { CampaignCritic, ModelAgent } from "./types.js";

export function createModelAgent(config: AppConfig): ModelAgent {
  if (config.modelProvider === "deterministic") return new DeterministicModelAgent();

  if (config.modelProvider === "gemini_api") {
    if (config.geminiApiKey === undefined) {
      throw new ModelAgentError(
        "MODEL_CONFIGURATION_INVALID",
        "Gemini API provider requires GEMINI_API_KEY.",
      );
    }
    return new GeminiModelAgent({
      provider: "gemini_api",
      model: config.geminiModel,
      apiKey: config.geminiApiKey,
    });
  }

  if (config.googleCloudProject === undefined) {
    throw new ModelAgentError(
      "MODEL_CONFIGURATION_INVALID",
      "Vertex AI provider requires GOOGLE_CLOUD_PROJECT.",
    );
  }
  return new GeminiModelAgent({
    provider: "vertex_ai",
    model: config.geminiModel,
    project: config.googleCloudProject,
    location: config.googleCloudLocation,
  });
}
export function createCampaignCritic(config: AppConfig): CampaignCritic | undefined {
  if (!config.enableGemma) return undefined;
  if (config.gemmaModel === undefined) {
    throw new ModelAgentError(
      "MODEL_CONFIGURATION_INVALID",
      "Gemma critic requires an exact GEMMA_MODEL ID.",
    );
  }

  if (config.modelProvider === "gemini_api" || config.geminiApiKey !== undefined) {
    if (config.geminiApiKey === undefined) {
      throw new ModelAgentError(
        "MODEL_CONFIGURATION_INVALID",
        "Gemma through the Gemini API requires GEMINI_API_KEY.",
      );
    }
    return new GemmaCriticAdapter({
      provider: "gemini_api",
      model: config.gemmaModel,
      apiKey: config.geminiApiKey,
    });
  }

  if (config.googleCloudProject === undefined) {
    throw new ModelAgentError(
      "MODEL_CONFIGURATION_INVALID",
      "Gemma critic requires either Gemini API credentials or a Vertex AI project.",
    );
  }
  return new GemmaCriticAdapter({
    provider: "vertex_ai",
    model: config.gemmaModel,
    project: config.googleCloudProject,
    location: config.googleCloudLocation,
  });
}
