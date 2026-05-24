/**
 * Tiny project-folder store for the KARO workbench.
 *
 * Manual project-folder store for the KARO workbench. The renderer
 * accepts only non-empty absolute path strings, then asks the desktop
 * shell to prove the path exists and is a directory before persisting
 * it under `recentProject` as context metadata.
 *
 * Validates: Requirements 1.4, 1.6 (no secrets touched here).
 */

import type { DesktopShell } from "../shell/types.js";

export const PROJECT_SETTING_KEY = "recentProject";

export interface ProjectInfo {
  readonly path: string;
  readonly savedAt: string;
}

function isProjectInfo(value: unknown): value is ProjectInfo {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return typeof o.path === "string" && typeof o.savedAt === "string";
}

export interface ProjectStoreOptions {
  readonly desktopShell: DesktopShell;
  readonly now?: () => Date;
}

export interface ProjectStore {
  read(): Promise<ProjectInfo | null>;
  write(path: string): Promise<ProjectInfo>;
  clear(): Promise<void>;
}

export function normalizeProjectPath(path: string): string {
  return path.trim().replace(/^['"]+|['"]+$/g, "").trim();
}

export function isAbsoluteProjectPath(path: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(path) ||
    /^\\\\[^\\/]+[\\/][^\\/]+/.test(path) ||
    /^\//.test(path)
  );
}

export function validateProjectPath(path: string): string {
  const normalized = normalizeProjectPath(path);
  if (normalized.length === 0) {
    throw new Error("Project path cannot be empty.");
  }
  if (!isAbsoluteProjectPath(normalized)) {
    throw new Error(
      "Enter an absolute folder path. Existence checks are unavailable in this desktop shell.",
    );
  }
  return normalized;
}

export function createProjectStore(
  options: ProjectStoreOptions,
): ProjectStore {
  const shell = options.desktopShell;
  const now = options.now ?? (() => new Date());
  return {
    async read(): Promise<ProjectInfo | null> {
      const raw = await shell.readLocalSetting<unknown>(PROJECT_SETTING_KEY);
      if (raw === null) return null;
      if (!isProjectInfo(raw)) return null;
      try {
        const validatedPath = validateProjectPath(raw.path);
        const nativeValidation = await shell.validateFolderPath?.(validatedPath);
        if (nativeValidation === undefined || !nativeValidation.ok) return null;
        return {
          path: nativeValidation.normalizedPath,
          savedAt: raw.savedAt,
        };
      } catch {
        return null;
      }
    },
    async write(path: string): Promise<ProjectInfo> {
      const validatedPath = validateProjectPath(path);
      const nativeValidation = await shell.validateFolderPath?.(validatedPath);
      if (nativeValidation === undefined) {
        throw new Error("Folder validation is unavailable in this runtime.");
      }
      if (!nativeValidation.ok) {
        throw new Error(formatFolderValidationError(validatedPath, nativeValidation));
      }
      const info: ProjectInfo = {
        path: nativeValidation.normalizedPath,
        savedAt: now().toISOString(),
      };
      await shell.writeLocalSetting(PROJECT_SETTING_KEY, info);
      return info;
    },
    async clear(): Promise<void> {
      await shell.deleteLocalSetting(PROJECT_SETTING_KEY);
    },
  };
}

function formatFolderValidationError(
  path: string,
  result: Exclude<Awaited<ReturnType<NonNullable<DesktopShell["validateFolderPath"]>>>, { ok: true }>,
): string {
  switch (result.reason) {
    case "not_found":
      return `Folder does not exist: ${path}`;
    case "not_directory":
      return "Path is not a folder.";
    case "permission_denied":
      return "Permission denied.";
    case "invalid_path":
      return result.message.length > 0 ? result.message : "Invalid project path.";
  }
}
