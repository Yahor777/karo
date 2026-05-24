export interface TokenUsageBreakdown {
  modelId: string;
  contextWindowTokens: number;
  usedTokens: number;
  usageRatio: number;
  systemPromptTokens: number;
  userPromptTokens: number;
  conversationTokens: number;
  projectContextTokens: number;
  selectedFilesTokens: number;
  toolResultTokens: number;
  outputTokens: number;
  reservedOutputTokens: number;
  estimatedCostUsd?: number;
  isEstimated: boolean;
  updatedAt: string;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  
  // Простая оценка:
  // Русские буквы
  const russianCharCount = (text.match(/[а-яА-ЯёЁ]/g) || []).length;
  // Английские буквы
  const englishCharCount = (text.match(/[a-zA-Z]/g) || []).length;
  // Остальные символы (код, пробелы, спецсимволы)
  const remainingCount = text.length - russianCharCount - englishCharCount;

  const tokens = (russianCharCount / 3.0) + (englishCharCount / 4.0) + (remainingCount / 3.5);
  return Math.ceil(tokens);
}

export function estimateMessagesTokens(messages: Array<{ role: string; content: string }>): number {
  let total = 0;
  for (const msg of messages) {
    total += 4; // Разметка сообщения
    total += estimateTokens(msg.content);
  }
  return total;
}

export function estimateFileContextTokens(files: Array<{ relativePath: string; content?: string }>): number {
  let total = 0;
  for (const file of files) {
    total += estimateTokens(file.relativePath);
    if (file.content) {
      total += estimateTokens(file.content);
    }
  }
  return total;
}

export function buildTokenUsageBreakdown(opts: {
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  selectedFiles?: Array<{ relativePath: string; content?: string }>;
  toolResults?: string;
  outputTokens?: number;
  reservedOutputTokens?: number;
  maxContextTokens?: number;
}): TokenUsageBreakdown {
  const systemPromptTokens = estimateTokens(opts.systemPrompt);
  const userPromptTokens = estimateTokens(opts.userPrompt);
  const conversationTokens = estimateMessagesTokens(opts.conversationHistory || []);
  const selectedFilesTokens = estimateFileContextTokens(opts.selectedFiles || []);
  const toolResultTokens = estimateTokens(opts.toolResults || "");
  const outputTokens = opts.outputTokens || 0;
  const reservedOutputTokens = opts.reservedOutputTokens || 8192;
  const contextWindowTokens = opts.maxContextTokens || 128_000;

  const usedTokens = systemPromptTokens + userPromptTokens + conversationTokens + selectedFilesTokens + toolResultTokens + outputTokens;
  const usageRatio = usedTokens / contextWindowTokens;

  // Оценка стоимости (например $15 за миллион токенов на вход, $30 на выход в среднем для Gemini Pro/Flash)
  const costInput = (usedTokens / 1_000_000) * 0.0015; // $1.5 / 1M input tokens
  const costOutput = (outputTokens / 1_000_000) * 0.0075; // $7.5 / 1M output tokens
  const estimatedCostUsd = parseFloat((costInput + costOutput).toFixed(6));

  return {
    modelId: opts.modelId,
    contextWindowTokens,
    usedTokens,
    usageRatio,
    systemPromptTokens,
    userPromptTokens,
    conversationTokens,
    projectContextTokens: selectedFilesTokens,
    selectedFilesTokens,
    toolResultTokens,
    outputTokens,
    reservedOutputTokens,
    estimatedCostUsd,
    isEstimated: true,
    updatedAt: new Date().toISOString(),
  };
}
