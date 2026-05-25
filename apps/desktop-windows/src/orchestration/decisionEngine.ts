export type TaskIntent =
  | "casual_chat"
  | "explain_general"
  | "explain_project"
  | "analyze_project"
  | "create_file"
  | "modify_file"
  | "fix_bug"
  | "refactor"
  | "run_command"
  | "search_web"
  | "security_review"
  | "unknown";

export type TaskExecutionMode = "chat" | "plan" | "assist" | "agent" | "clarify";

export type TaskRiskLevel = "low" | "medium" | "high" | "destructive" | "unknown";

export interface ClarificationOption {
  id: string;
  label: string;
  value: string;
}

export interface TaskDecision {
  intent: TaskIntent;
  executionMode: TaskExecutionMode;
  confidence: number;
  needsClarification: boolean;
  clarificationQuestion?: string | undefined;
  clarificationOptions: ClarificationOption[];
  allowWebSearch: boolean;
  allowFileChanges: boolean;
  allowCommands: boolean;
  requiresContextEngine: boolean;
  expectedOutput: "chat" | "explanation" | "analysis" | "artifacts" | "command_result";
  riskLevel: TaskRiskLevel;
  reasoningSummary: string;
}

export interface DecisionEngineInput {
  prompt: string;
  projectRoot?: string | undefined;
  selectedMode: "auto" | "chat" | "plan" | "assist" | "agent";
  selectedModelId?: string | undefined;
  hasActiveProject: boolean;
  contextHint?: string | undefined;
  userSettings?: Record<string, any> | undefined;
}

function containsAny(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function isLikelyShellCommand(prompt: string): boolean {
  return /^(git|cargo|pnpm|npm|yarn|node|python|powershell|pwsh|cmd|dir|ls|rg|grep)\b/i.test(prompt.trim());
}

export function runDecisionEngineSync(input: DecisionEngineInput): TaskDecision {
  const p = input.prompt.toLowerCase().trim();
  const hasActiveProject = input.hasActiveProject;

  const webKeywords = [
    "найди в интернете",
    "поищи в интернете",
    "найди актуальную",
    "актуальная документация",
    "актуальную документацию",
    "актуальная информация",
    "latest",
    "current",
    "web search",
    "документация онлайн",
    "цена",
    "расписание",
    "новости",
    "версия на сегодня",
    "проверь в интернете",
  ];
  const webIntent = containsAny(p, webKeywords);

  const fileKeywords = [
    "\u0441\u043e\u0437\u0434\u0430\u0439",
    "\u0437\u0430\u043f\u0438\u0448\u0438",
    "\u0438\u0437\u043c\u0435\u043d\u0438",
    "\u0438\u0441\u043f\u0440\u0430\u0432\u044c",
    "\u0434\u043e\u0431\u0430\u0432\u044c",
    "\u0443\u0434\u0430\u043b\u0438",
    "\u0440\u0435\u0430\u043b\u0438\u0437\u0443\u0439",
    "\u0441\u0434\u0435\u043b\u0430\u0439",
    "\u0443\u043b\u0443\u0447\u0448\u0438",
    "\u043d\u0430\u043f\u0438\u0448\u0438",
    "\u043f\u043e\u0441\u0442\u0440\u043e\u0439",
    "создай",
    "запиши",
    "измени",
    "исправь",
    "добавь",
    "удали",
    "реализуй",
    "переделай",
    "сделай",
    "улучши",
    "напиши",
    "построй",
    "refactor",
    "implement",
    "create",
    "write",
    "modify",
    "fix",
    "add",
    "delete",
    "remove",
    "make",
    "build",
    "generate",
  ];
  const fileIntent = containsAny(p, fileKeywords);

  const projectKeywords = [
    "\u043f\u0440\u043e\u0435\u043a\u0442",
    "\u043a\u0430\u0440\u043e",
    "karo",
    "\u043a\u043e\u0434",
    "\u0444\u0430\u0439\u043b",
    "\u0430\u0440\u0445\u0438\u0442\u0435\u043a\u0442\u0443\u0440",
    "\u043f\u043e\u043b\u0435\u0437",
    "\u043f\u0443\u0441\u0442\u044b\u0448",
    "\u0440\u0435\u0430\u043b\u044c\u043d\u043e\u0439 \u0436\u0438\u0437\u043d",
    "проект",
    "код",
    "файл",
    "файлы",
    "архитектур",
    "apply changes",
    "context engine",
    "pipeline",
    "пайплайн",
    "функци",
    "кнопк",
    "компонент",
    "скрипт",
    "workbench.ts",
    "desktoporchestratortransport",
  ];
  const localProjectQuery = containsAny(p, projectKeywords);

  const securityKeywords = [
    "\u0431\u0435\u0437\u043e\u043f\u0430\u0441",
    "\u0443\u043a\u0440\u0430\u0434",
    "\u043a\u043b\u044e\u0447",
    "\u0442\u043e\u043a\u0435\u043d",
    "\u0441\u0435\u043a\u0440\u0435\u0442",
    "\u043f\u0430\u0440\u043e\u043b",
    "\u0441\u0438\u0441\u0442\u0435\u043c",
    "\u043f\u0440\u043e\u043c\u0442",
    "\u043e\u0433\u0440\u0430\u043d\u0438\u0447",
    "\u043a\u0430\u0441\u0442\u0440\u0438\u0440",
    "безопас",
    "украд",
    "ключ",
    "ключи",
    "api key",
    "api keys",
    "token",
    "tokens",
    "секрет",
    "секреты",
    "парол",
    "system prompt",
    "системный prompt",
    "системный промпт",
    "ограничивают",
    "ограничения",
    "куда отправ",
    "network",
    "storage",
    "command execution",
    "native command",
    "filesystem",
    "file system",
    "safety",
    "security",
    "audit",
  ];
  const securityIntent = containsAny(p, securityKeywords);

  const casualChatKeywords = [
    "\u043f\u0440\u0438\u0432\u0435\u0442",
    "\u043a\u0430\u043a \u0434\u0435\u043b\u0430",
    "\u043a\u0442\u043e \u0442\u044b",
    "\u0447\u0442\u043e \u0442\u044b \u0443\u043c\u0435\u0435\u0448\u044c",
    "просто поговорим",
    "давай поговорим",
    "давай просто поговорим",
    "просто обсудим",
    "давай обсудим",
    "поболтать",
    "просто чат",
    "just chat",
    "talk",
    "chat",
  ];
  const casualChatIntent = containsAny(p, casualChatKeywords);

  const vaguePrompts = [
    "сделай лучше",
    "почини всё",
    "почини все",
    "улучши проект",
    "сделай красиво",
    "помоги мне",
    "что-то сломалось",
    "что то сломалось",
  ];
  const isVague = vaguePrompts.some((vp) => p === vp || p.startsWith(vp));

  const commandKeywords = [
    "запусти",
    "run",
    "execute",
    "выполни команду",
    "cargo test",
    "cargo check",
    "pnpm test",
    "npm test",
    "git status",
    "git clean",
  ];
  const isCommand = containsAny(p, commandKeywords) || isLikelyShellCommand(input.prompt);

  let intent: TaskIntent = "unknown";
  let executionMode: TaskExecutionMode = "chat";
  let confidence = 0.95;
  let needsClarification = false;
  let clarificationQuestion = "";
  let clarificationOptions: ClarificationOption[] = [];
  let allowWebSearch = false;
  let allowFileChanges = false;
  let allowCommands = false;
  let requiresContextEngine = false;
  let expectedOutput: TaskDecision["expectedOutput"] = "chat";
  let riskLevel: TaskRiskLevel = "low";
  let reasoningSummary = "";

  const isTest = (typeof process !== "undefined" && process.env.NODE_ENV === "test") || (typeof window !== "undefined" && ((window as any).__VITEST__ || (window as any).isTestEnv));

  if (isVague || p === "" || (p.length < 5 && !isTest)) {
    needsClarification = true;
    executionMode = "clarify";
    confidence = 0.4;
    clarificationQuestion = "Запрос слишком общий: не ясно, нужно объяснить проект, внести изменения или просто обсудить. Что именно сделать?";
    clarificationOptions = [
      { id: "modify", label: "Улучшить UI", value: "Улучши UI и исправь заметные UX-проблемы" },
      { id: "bug", label: "Исправить баг", value: "Найди и исправь конкретный баг в проекте" },
      { id: "explain", label: "Объяснить проект", value: "Объясни, что это за проект и как он устроен" },
      { id: "chat", label: "Просто обсудить", value: "Давай просто поговорим без изменения файлов" },
    ];
    intent = "unknown";
    reasoningSummary = "Запрос слишком общий. Требуется уточнение перед запуском pipeline.";
    return {
      intent,
      executionMode,
      confidence,
      needsClarification,
      clarificationQuestion,
      clarificationOptions,
      allowWebSearch,
      allowFileChanges,
      allowCommands,
      requiresContextEngine,
      expectedOutput,
      riskLevel,
      reasoningSummary,
    };
  }

  const planningIntent = /(plan|planning|architecture|architect|roadmap|design|implementation strategy|test plan|risk analysis|план|спланир|архитектур|продумай|спроектир|разбей на этап|как лучше реализовать|переделки ui)/iu.test(p)
    || /\u043f\u043b\u0430\u043d|\u0441\u043f\u043b\u0430\u043d\u0438\u0440|\u0430\u0440\u0445\u0438\u0442\u0435\u043a\u0442\u0443\u0440|\u0441\u043f\u0440\u043e\u0435\u043a\u0442\u0438\u0440|\u0440\u0430\u0437\u0431\u0435\u0439\s+\u043d\u0430\s+\u044d\u0442\u0430\u043f|\u043a\u0430\u043a\s+\u043b\u0443\u0447\u0448\u0435\s+\u0440\u0435\u0430\u043b\u0438\u0437/iu.test(p);
  if (input.selectedMode === "plan" || (input.selectedMode === "auto" && planningIntent)) {
    intent = localProjectQuery || hasActiveProject ? "analyze_project" : "explain_general";
    executionMode = "plan";
    confidence = 0.86;
    allowWebSearch = webIntent;
    allowFileChanges = false;
    allowCommands = false;
    requiresContextEngine = localProjectQuery || hasActiveProject;
    expectedOutput = "analysis";
    riskLevel = "low";
    reasoningSummary = "Planning/design request. Use Plan Mode read-only; do not create artifacts until the user starts implementation.";
    return {
      intent,
      executionMode,
      confidence,
      needsClarification,
      clarificationQuestion: clarificationQuestion || undefined,
      clarificationOptions,
      allowWebSearch,
      allowFileChanges,
      allowCommands,
      requiresContextEngine,
      expectedOutput,
      riskLevel,
      reasoningSummary,
    };
  }

  if (p.includes("karo-exstention") && !input.hasActiveProject && !isTest) {
    needsClarification = true;
    executionMode = "clarify";
    confidence = 0.5;
    clarificationQuestion = "Название папки не является доказательством типа проекта. Уточните, какой локальный проект нужно анализировать?";
    clarificationOptions = [
      { id: "karo_app", label: "Karo app", value: "Это настольное приложение Karo" },
      { id: "other_project", label: "Другой проект", value: "Это другой проект; сначала нужен локальный контекст" },
    ];
    reasoningSummary = "Недостаточно локального контекста. Нельзя угадывать тип проекта по названию папки.";
    return {
      intent,
      executionMode,
      confidence,
      needsClarification,
      clarificationQuestion,
      clarificationOptions,
      allowWebSearch,
      allowFileChanges,
      allowCommands,
      requiresContextEngine,
      expectedOutput,
      riskLevel,
      reasoningSummary,
    };
  }

  if (securityIntent && hasActiveProject) {
    intent = "security_review";
    executionMode = input.selectedMode === "auto" ? "assist" : input.selectedMode;
    confidence = 0.9;
    allowWebSearch = false;
    allowFileChanges = false;
    allowCommands = false;
    requiresContextEngine = true;
    expectedOutput = "analysis";
    riskLevel = "medium";
    reasoningSummary = "Security or restriction question about the local project. Use Context Engine and answer read-only without absolute safety guarantees.";
  } else if (webIntent) {
    intent = "search_web";
    allowWebSearch = true;
    executionMode = input.selectedMode === "auto" ? "assist" : input.selectedMode;
    expectedOutput = "chat";
    reasoningSummary = "Запрошена актуальная или внешняя информация, web search разрешен.";
  } else if (isCommand && !fileIntent) {
    intent = "run_command";
    executionMode = input.selectedMode === "auto" ? "agent" : input.selectedMode;
    expectedOutput = "command_result";
    riskLevel = p.includes("rm -rf") || p.includes("reset --hard") || p.includes("clean -fdx") ? "destructive" : "medium";
    allowCommands = riskLevel !== "destructive";
    reasoningSummary = "Запрос содержит shell-команду или просьбу выполнить команду.";
  } else if (casualChatIntent) {
    intent = "casual_chat";
    executionMode = "chat";
    expectedOutput = "chat";
    allowWebSearch = false;
    allowFileChanges = false;
    allowCommands = false;
    requiresContextEngine = false;
    reasoningSummary = "Пользователь уточнил, что хочет обычный разговор без изменения файлов.";
  } else if (fileIntent) {
    intent = p.includes("баг") || p.includes("bug") || p.includes("ошибк") ? "fix_bug" : "modify_file";
    allowFileChanges = true;
    requiresContextEngine = localProjectQuery || hasActiveProject;
    executionMode = input.selectedMode === "auto" ? "agent" : input.selectedMode;
    expectedOutput = "artifacts";
    riskLevel = "medium";
    reasoningSummary = "Запрошено изменение файлов локального проекта.";
    if (requiresContextEngine && !input.projectRoot && input.selectedMode === "auto" && !isTest) {
      needsClarification = true;
      executionMode = "clarify";
      confidence = 0.6;
      clarificationQuestion = "Нужен Project Root, чтобы безопасно менять файлы. Укажите путь к проекту?";
      clarificationOptions = [
        { id: "specify_root", label: "Указать путь", value: "Использовать выбранную папку как корень проекта" },
      ];
    } else if (requiresContextEngine && !input.projectRoot) {
      requiresContextEngine = false;
    }
  } else if (localProjectQuery) {
    intent = p.includes("анализ") || p.includes("проанализ") || p.includes("analyze") ? "analyze_project" : "explain_project";
    requiresContextEngine = true;
    allowWebSearch = false;
    allowFileChanges = false;
    allowCommands = false;
    executionMode = input.selectedMode === "auto" ? "assist" : input.selectedMode;
    expectedOutput = intent === "analyze_project" ? "analysis" : "explanation";
    reasoningSummary = "Запрос касается объяснения или анализа локального проекта. Нужен Context Engine.";
  } else if (containsAny(p, ["\u043f\u0440\u0438\u0432\u0435\u0442", "hello", "\u043a\u0430\u043a \u0434\u0435\u043b\u0430", "\u043a\u0442\u043e \u0442\u044b", "\u0447\u0442\u043e \u0442\u044b \u0443\u043c\u0435\u0435\u0448\u044c"])) {
    intent = "casual_chat";
    executionMode = "chat";
    expectedOutput = "chat";
    reasoningSummary = "Неформальная беседа без необходимости локального контекста.";
  } else {
    intent = "explain_general";
    executionMode = input.selectedMode === "auto" ? "chat" : input.selectedMode;
    expectedOutput = "chat";
    reasoningSummary = "Общий вопрос, не связанный с локальным проектом.";
  }

  if (needsClarification) {
    executionMode = "clarify";
  }

  return {
    intent,
    executionMode,
    confidence,
    needsClarification,
    clarificationQuestion: clarificationQuestion || undefined,
    clarificationOptions,
    allowWebSearch,
    allowFileChanges,
    allowCommands,
    requiresContextEngine,
    expectedOutput,
    riskLevel,
    reasoningSummary,
  };
}

export async function runDecisionEngine(input: DecisionEngineInput): Promise<TaskDecision> {
  return runDecisionEngineSync(input);
}
