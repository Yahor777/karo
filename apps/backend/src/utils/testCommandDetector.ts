import * as fs from "node:fs";
import * as path from "node:path";

export interface DetectedTestCommand {
  kind: "detected";
  command: string;
  args: string[];
  source: "explicit-config" | "package-json" | "direct-runner";
  packageManager: "pnpm" | "npm" | "yarn" | "unknown";
  requiresConsent: boolean;
  reason: string;
}

export interface NotFoundTestCommand {
  kind: "not_found";
  reason: string;
}

export interface BlockedTestCommand {
  kind: "blocked";
  reason: string;
}

export type DetectTestCommandResult =
  | DetectedTestCommand
  | NotFoundTestCommand
  | BlockedTestCommand;

export interface DetectTestCommandInput {
  cwd: string;
  changedFileNames?: string[];
  allowPackageScripts?: boolean;
}

/**
 * Safely auto-detects test command from staging package.json.
 */
export async function detectTestCommand(
  input: DetectTestCommandInput
): Promise<DetectTestCommandResult> {
  const { cwd, changedFileNames, allowPackageScripts = false } = input;

  if (!path.isAbsolute(cwd)) {
    throw new Error("cwd must be absolute");
  }

  let pkgPath: string | null = null;
  let pkgDir: string | null = null;

  // Search package.json for changedFileNames first
  if (changedFileNames && changedFileNames.length > 0) {
    for (const fileName of changedFileNames) {
      const absPath = path.resolve(cwd, fileName);
      // Safety check: ensure file is inside cwd to prevent path traversal
      const relative = path.relative(cwd, absPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        continue;
      }

      let dir = path.dirname(absPath);
      while (true) {
        const checkPath = path.join(dir, "package.json");
        if (fs.existsSync(checkPath)) {
          pkgPath = checkPath;
          pkgDir = dir;
          break;
        }
        if (dir === cwd) {
          break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
          break;
        }
        dir = parent;
      }

      if (pkgPath) {
        break;
      }
    }
  }

  // Fallback to cwd root package.json
  if (!pkgPath) {
    const rootPkg = path.join(cwd, "package.json");
    if (fs.existsSync(rootPkg)) {
      pkgPath = rootPkg;
      pkgDir = cwd;
    }
  }

  if (!pkgPath || !pkgDir) {
    return {
      kind: "not_found",
      reason: "No package.json found in staging workspace",
    };
  }

  // Read and parse package.json
  let packageJson: any;
  try {
    const content = fs.readFileSync(pkgPath, "utf-8");
    packageJson = JSON.parse(content);
  } catch (err: any) {
    return {
      kind: "not_found",
      reason: `Failed to read or parse package.json: ${err.message}`,
    };
  }

  if (!packageJson || typeof packageJson !== "object" || !packageJson.scripts || typeof packageJson.scripts !== "object") {
    return {
      kind: "not_found",
      reason: "No 'scripts' section found in package.json",
    };
  }

  const testScript = packageJson.scripts.test;
  if (typeof testScript !== "string" || testScript.trim().length === 0) {
    return {
      kind: "not_found",
      reason: "No 'test' script found in package.json",
    };
  }

  const script = testScript.trim();

  // Check for default npm test placeholder
  const placeholderRegex = /^echo\s+["']Error:\s+no\s+test\s+specified["']\s+&&\s+exit\s+1$/i;
  if (placeholderRegex.test(script)) {
    return {
      kind: "not_found",
      reason: "Default npm test placeholder detected",
    };
  }

  // Safety check: block dangerous commands
  if (
    script.includes("rm -rf") ||
    /\bdel\s+\/f\b/i.test(script) ||
    /\bformat\b/i.test(script) ||
    /\bpowershell\b/i.test(script) ||
    /\bcmd\.exe\b/i.test(script) ||
    /curl\s*\|\s*sh/i.test(script) ||
    /wget\s*\|\s*sh/i.test(script) ||
    /\bsudo\b/i.test(script) ||
    script.includes(">") ||
    script.includes("<") ||
    script.includes("|") ||
    script.includes("&")
  ) {
    return {
      kind: "blocked",
      reason: `Blocked potentially dangerous test script: "${testScript}"`,
    };
  }

  // Detect package manager
  let packageManager: "pnpm" | "npm" | "yarn" | "unknown" = "unknown";
  const checkDirs = [pkgDir];
  if (pkgDir !== cwd) {
    checkDirs.push(cwd);
  }

  for (const dir of checkDirs) {
    if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) {
      packageManager = "pnpm";
      break;
    }
    if (fs.existsSync(path.join(dir, "yarn.lock"))) {
      packageManager = "yarn";
      break;
    }
    if (fs.existsSync(path.join(dir, "package-lock.json"))) {
      packageManager = "npm";
      break;
    }
  }

  const resolvedPm = packageManager === "unknown" ? "npm" : packageManager;

  return {
    kind: "detected",
    command: resolvedPm,
    args: ["test"],
    source: "package-json",
    packageManager,
    requiresConsent: !allowPackageScripts,
    reason: `Detected test command from package.json using ${packageManager} package manager`,
  };
}
