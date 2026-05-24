export interface ModelCapabilityProfile {
  modelId: string;
  jsonReliability: number; // 0.0 to 1.0
  instructionFollowing: number;
  clarificationReliability: number;
  toolSafety: number;
  recommendedPreset: "small_model_safe" | "medium_model_balanced" | "large_model_deep";
  recommendedMaxContextTokens?: number;
  createdAt: string;
}

export function probeModelCapabilitySync(modelId: string): ModelCapabilityProfile {
  const m = modelId.toLowerCase();
  
  let jsonReliability = 0.95;
  let instructionFollowing = 0.9;
  let clarificationReliability = 0.85;
  let toolSafety = 0.8;
  let recommendedPreset: ModelCapabilityProfile["recommendedPreset"] = "medium_model_balanced";
  let recommendedMaxContextTokens = 128_000;

  if (m.includes("flash") || m.includes("mini") || m.includes("haiku") || m.includes("small")) {
    jsonReliability = 0.8;
    instructionFollowing = 0.75;
    clarificationReliability = 0.8;
    toolSafety = 0.7;
    recommendedPreset = "small_model_safe";
    recommendedMaxContextTokens = 32_000;
  } else if (m.includes("ultra") || m.includes("large") || m.includes("opus") || m.includes("deep") || m.includes("o1") || m.includes("o3")) {
    jsonReliability = 0.99;
    instructionFollowing = 0.98;
    clarificationReliability = 0.95;
    toolSafety = 0.95;
    recommendedPreset = "large_model_deep";
    recommendedMaxContextTokens = 200_000;
  } else {
    jsonReliability = 0.95;
    instructionFollowing = 0.9;
    clarificationReliability = 0.9;
    toolSafety = 0.85;
    recommendedPreset = "medium_model_balanced";
    recommendedMaxContextTokens = 128_000;
  }

  return {
    modelId,
    jsonReliability,
    instructionFollowing,
    clarificationReliability,
    toolSafety,
    recommendedPreset,
    recommendedMaxContextTokens,
    createdAt: new Date().toISOString(),
  };
}

export async function probeModelCapability(modelId: string): Promise<ModelCapabilityProfile> {
  // Для MVP возвращаем синхронную спецификацию, так как
  // тесты не должны зависеть от реальных сетевых подключений
  return probeModelCapabilitySync(modelId);
}
