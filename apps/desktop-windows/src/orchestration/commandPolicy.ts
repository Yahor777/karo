export type CommandPermissionMode = "safe_commands" | "smart_approval" | "full_access_smart";

export type CommandRiskLevel = "safe" | "low" | "medium" | "high" | "destructive" | "unknown";

export interface CommandDecision {
  command: string;
  riskLevel: CommandRiskLevel;
  permissionMode: CommandPermissionMode;
  canRunAutomatically: boolean;
  requiresApproval: boolean;
  blocked: boolean;
  reason: string;
  rollbackAvailable: boolean;
  rollbackPlan?: string | undefined;
  suggestedSaferCommand?: string | undefined;
  warnings: string[];
}

export interface CommandPolicyInput {
  command: string;
  cwd: string;
  projectRoot: string;
  permissionMode: CommandPermissionMode;
  gitStatus?: string | undefined;
  hasBackups?: boolean | undefined;
  userPrompt?: string | undefined;
}

export function runCommandPolicy(input: CommandPolicyInput): CommandDecision {
  const cmd = input.command.trim();
  const cmdLower = cmd.toLowerCase();

  let riskLevel: CommandRiskLevel = "unknown";
  let reason = "";
  let rollbackAvailable = false;
  let rollbackPlan = "";
  let suggestedSaferCommand = "";
  const warnings: string[] = [];

  const root = input.projectRoot.trim().toLowerCase();
  const cwd = input.cwd.trim().toLowerCase();
  const isOutsideRoot = Boolean(root) && !cwd.startsWith(root);
  if (isOutsideRoot) {
    warnings.push("Команда выполняется за пределами корня проекта.");
  }

  const safeCommands = [
    "git status",
    "git diff",
    "git diff --stat",
    "git log",
    "dir",
    "ls",
    "get-childitem",
    "get-content",
    "cat",
    "cargo check",
    "cargo test",
    "pnpm test",
    "npm test",
    "pnpm exec tsc",
    "rg",
    "grep",
    "findstr",
    "where.exe",
    "get-command",
  ];

  const installCommands = [
    "pnpm install",
    "npm install",
    "cargo update",
    "yarn install",
    "pnpm add",
    "npm i",
  ];

  const gitStateCommands = [
    "git checkout",
    "git switch",
    "git stash",
    "git clean",
  ];

  const destructiveCommands = [
    "rm -rf",
    "remove-item",
    "del /s",
    "rmdir /s",
    "git reset --hard",
    "git clean -fdx",
    "format",
    "diskpart",
  ];

  const highCommands = [
    "git reset",
    "git clean",
    "npm publish",
    "pnpm publish",
    "yarn publish",
    "curl",
    "wget",
    "invoke-webrequest",
  ];

  const isSafe = safeCommands.some((c) => cmdLower === c || cmdLower.startsWith(`${c} `));
  const isInstall = installCommands.some((c) => cmdLower === c || cmdLower.startsWith(`${c} `));
  const isGitState = gitStateCommands.some((c) => cmdLower === c || cmdLower.startsWith(`${c} `));
  const isDestructive = destructiveCommands.some((c) => cmdLower.includes(c));
  const isHigh = highCommands.some((c) => cmdLower.includes(c));

  if (isDestructive) {
    riskLevel = "destructive";
    reason = "Команда содержит разрушительные или системно-опасные операции.";
    rollbackAvailable = false;
    rollbackPlan = "Откат невозможен без предварительного backup, git stash или dry-run.";
    if (cmdLower.includes("git clean -fdx")) {
      suggestedSaferCommand = "git clean -ndx";
      rollbackPlan = "Сначала выполните dry-run: git clean -ndx";
    } else if (cmdLower.includes("remove-item") || cmdLower.includes("rm -rf")) {
      suggestedSaferCommand = cmd.includes("-WhatIf") ? "" : `${cmd} -WhatIf`;
      rollbackPlan = "Сначала проверьте список удаляемых файлов через dry-run/WhatIf.";
    }
  } else if (isHigh) {
    riskLevel = "high";
    reason = "Команда имеет высокий риск: сеть, публикация или изменение git-состояния.";
    rollbackAvailable = false;
    rollbackPlan = "Требуется ручная проверка перед запуском.";
  } else if (isInstall || isGitState) {
    riskLevel = "medium";
    reason = "Команда меняет состояние репозитория или дерево зависимостей.";
    rollbackAvailable = true;
    rollbackPlan = "Откат обычно возможен через git status/diff и восстановление измененных файлов.";
  } else if (isSafe) {
    riskLevel = "safe";
    reason = "Команда безопасна: чтение, статус, поиск или тесты.";
    rollbackAvailable = true;
    rollbackPlan = "Команда не должна менять файлы проекта.";
  } else {
    riskLevel = "low";
    reason = "Команда не распознана как опасная, но требует стандартной проверки.";
    rollbackAvailable = true;
  }

  let canRunAutomatically = false;
  let requiresApproval = true;
  let blocked = false;

  const mode = input.permissionMode;

  if (mode === "safe_commands") {
    if (riskLevel === "safe") {
      canRunAutomatically = true;
      requiresApproval = false;
    } else if (riskLevel === "destructive") {
      blocked = cmdLower.includes("rm -rf /") || cmdLower.includes("del /s /q c:\\");
      requiresApproval = true;
      canRunAutomatically = false;
      if (blocked) {
        reason = "Смертельно опасная команда на корне диска заблокирована политикой Karo.";
      }
    } else {
      requiresApproval = true;
      canRunAutomatically = false;
    }
  } else if (mode === "smart_approval") {
    if (riskLevel === "safe" || riskLevel === "low") {
      canRunAutomatically = true;
      requiresApproval = false;
    } else {
      requiresApproval = true;
      canRunAutomatically = false;
    }
  } else if (mode === "full_access_smart") {
    if (riskLevel === "safe" || riskLevel === "low" || riskLevel === "medium") {
      if (isOutsideRoot) {
        requiresApproval = true;
        canRunAutomatically = false;
        reason = "Автозапуск запрещен: CWD находится вне projectRoot.";
      } else {
        canRunAutomatically = true;
        requiresApproval = false;
      }
    } else if (riskLevel === "high") {
      const gitStatusClean = !input.gitStatus || input.gitStatus.trim() === "";
      if (!isOutsideRoot && gitStatusClean) {
        canRunAutomatically = true;
        requiresApproval = false;
      } else {
        requiresApproval = true;
        canRunAutomatically = false;
        reason = "Команда высокого риска требует одобрения из-за git changes или CWD вне projectRoot.";
      }
    } else if (riskLevel === "destructive") {
      requiresApproval = true;
      canRunAutomatically = false;
      reason = "Разрушительные команды никогда не выполняются автоматически.";
    }
  }

  return {
    command: cmd,
    riskLevel,
    permissionMode: mode,
    canRunAutomatically,
    requiresApproval,
    blocked,
    reason,
    rollbackAvailable,
    rollbackPlan: rollbackPlan || undefined,
    suggestedSaferCommand: suggestedSaferCommand || undefined,
    warnings,
  };
}
