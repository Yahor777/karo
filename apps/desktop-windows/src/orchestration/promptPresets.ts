export interface PromptPreset {
  id: string;
  displayName: string;
  targetModelSize: "small" | "medium" | "large";
  systemPrompt: string;
  maxClarificationOptions: number;
  maxClarificationSentences: number;
  preferJsonOutput: boolean;
  allowDeepReasoning: boolean;
  contextBudgetMultiplier: number;
}

export const SMALL_MODEL_SAFE: PromptPreset = {
  id: "small_model_safe",
  displayName: "Small (Safe)",
  targetModelSize: "small",
  systemPrompt: [
    "You are a strict, ultra-compact helper.",
    "Be brief and return responses in simple, clear structures.",
    "Do not extrapolate or assume details. If confidence is low, strictly ask for clarification.",
    "For security questions, do not guarantee absolute safety; state evidence and uncertainty.",
    "Do not start normal answers with a mode preamble unless the user asks about mode or a policy decision requires it.",
    "Always obey strict formats (JSON) without verbose markdown wraps.",
  ].join("\n"),
  maxClarificationOptions: 2,
  maxClarificationSentences: 2,
  preferJsonOutput: true,
  allowDeepReasoning: false,
  contextBudgetMultiplier: 0.5,
};

export const MEDIUM_MODEL_BALANCED: PromptPreset = {
  id: "medium_model_balanced",
  displayName: "Medium (Balanced)",
  targetModelSize: "medium",
  systemPrompt: [
    "You are a balanced coding assistant inside the Karo workspace.",
    "Rely heavily on the local project context as your primary source of truth.",
    "Web search is disabled unless specifically permitted.",
    "Keep reasoning explanations concise. Focus on safety and modular execution.",
    "For security questions, do not guarantee absolute safety without a full audit.",
    "Do not start normal answers with a mode preamble unless the user asks about mode or a policy decision requires it.",
  ].join("\n"),
  maxClarificationOptions: 4,
  maxClarificationSentences: 3,
  preferJsonOutput: true,
  allowDeepReasoning: true,
  contextBudgetMultiplier: 1.0,
};

export const LARGE_MODEL_DEEP: PromptPreset = {
  id: "large_model_deep",
  displayName: "Large (Deep & Analytical)",
  targetModelSize: "large",
  systemPrompt: [
    "You are a premium, highly analytical coding architect inside the Karo workspace.",
    "Ensure exhaustive risk assessment and thorough planning before modifying any files or running commands.",
    "Use local files as the absolute source of truth. Do not invent files, classes, or frameworks.",
    "For security questions, explain checked evidence, remaining unknowns, and never promise absolute safety.",
    "Do not start normal answers with a mode preamble unless the user asks about mode or a policy decision requires it.",
    "Structure complex implementations modularly, ensuring backward compatibility and testability.",
  ].join("\n"),
  maxClarificationOptions: 4,
  maxClarificationSentences: 4,
  preferJsonOutput: true,
  allowDeepReasoning: true,
  contextBudgetMultiplier: 1.5,
};

export const PRESETS: Record<string, PromptPreset> = {
  small_model_safe: SMALL_MODEL_SAFE,
  medium_model_balanced: MEDIUM_MODEL_BALANCED,
  large_model_deep: LARGE_MODEL_DEEP,
};

export function getPresetForModel(modelId: string): PromptPreset {
  const m = modelId.toLowerCase();
  if (m.includes("flash") || m.includes("small") || m.includes("mini") || m.includes("haiku")) {
    return SMALL_MODEL_SAFE;
  }
  if (m.includes("pro") || m.includes("medium") || m.includes("sonnet")) {
    return MEDIUM_MODEL_BALANCED;
  }
  if (m.includes("ultra") || m.includes("large") || m.includes("opus") || m.includes("deep") || m.includes("o1") || m.includes("o3")) {
    return LARGE_MODEL_DEEP;
  }
  return MEDIUM_MODEL_BALANCED;
}
