import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TaskId } from "@ai-agent-orchestrator/shared-core";

/**
 * Manages the isolated staging workspace for tasks (task 2.1).
 *
 * Ensures that agents (Coder, Fixer) write their file artifacts to a sandbox
 * directory under `.karo/staging/<task-id>/` before they are approved by the
 * Boss and merged into the main project.
 */
export class StagingWorkspaceManager {
  /**
   * Initializes the manager with the root path of the project.
   *
   * @param projectRoot Absolute path to the user's workspace root.
   */
  public constructor(private readonly projectRoot: string) {
    if (!path.isAbsolute(projectRoot)) {
      throw new Error(`Project root must be an absolute path: ${projectRoot}`);
    }
  }

  /**
   * Returns the normalized absolute path to the staging directory for a task.
   */
  public getStagingRoot(taskId: TaskId): string {
    if (!taskId || typeof taskId !== "string" || taskId.trim().length === 0) {
      throw new Error("taskId must be a non-empty string");
    }
    return path.resolve(this.projectRoot, ".karo", "staging", taskId);
  }

  /**
   * Initializes the isolated staging workspace for a task.
   * Copies the project structure (excluding specific directories/files) and
   * creates a Directory Junction/Symlink to the original node_modules folder.
   *
   * @param taskId The task identifier.
   * @returns Absolute path to the staging workspace.
   */
  public async initializeWorkspace(taskId: TaskId): Promise<string> {
    const stagingRoot = this.getStagingRoot(taskId);

    // Safe repeated call: completely clear old staging task dir to avoid stale files
    // and recreate a clean environment.
    await this.cleanStagingDir(taskId);
    await this.ensureStagingDir(taskId);

    // Recursively copy project files into the staging workspace.
    await this.copyProjectStructure(this.projectRoot, stagingRoot, stagingRoot);

    // If node_modules exists in projectRoot, create symlink/junction.
    const realNodeModules = path.join(this.projectRoot, "node_modules");
    try {
      const stats = await fs.stat(realNodeModules);
      if (stats.isDirectory()) {
        const stagingNodeModules = path.join(stagingRoot, "node_modules");
        // On Windows use "junction" which does not require elevated/admin privileges.
        // On other platforms, use standard directory symlink ("dir").
        const type = process.platform === "win32" ? "junction" : "dir";
        await fs.symlink(realNodeModules, stagingNodeModules, type);
      }
    } catch (err: any) {
      // If node_modules is missing, do not fail.
      if (err.code !== "ENOENT") {
        throw err;
      }
    }

    return stagingRoot;
  }

  /**
   * Recursively copies files and folders from source to destination, ignoring excluded patterns.
   */
  private async copyProjectStructure(src: string, dest: string, stagingRoot: string): Promise<void> {
    const entries = await fs.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (this.shouldExclude(entry.name, srcPath, stagingRoot)) {
        continue;
      }

      if (entry.isDirectory()) {
        await fs.mkdir(destPath, { recursive: true });
        await this.copyProjectStructure(srcPath, destPath, stagingRoot);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }

  /**
   * Determines if a file or directory should be excluded from staging.
   */
  private shouldExclude(name: string, absolutePath: string, stagingRoot: string): boolean {
    const excludedDirs = [
      ".git",
      ".karo",
      "node_modules",
      "dist",
      "build",
      ".next",
      "coverage",
      "logs",
    ];

    if (excludedDirs.includes(name)) {
      return true;
    }

    if (name.endsWith(".log")) {
      return true;
    }

    // Defensive check: prevent copying the destination workspace itself if it lies under the source
    if (absolutePath === stagingRoot || absolutePath.startsWith(stagingRoot + path.sep)) {
      return true;
    }

    return false;
  }

  /**
   * Ensures that the staging directory for the task exists.
   */
  public async ensureStagingDir(taskId: TaskId): Promise<void> {
    const stagingRoot = this.getStagingRoot(taskId);
    await fs.mkdir(stagingRoot, { recursive: true });
  }

  /**
   * Resolves the absolute path for an artifact file inside the task's staging directory.
   * Strictly prevents path traversal attacks (e.g., via absolute paths, '../', or '..\').
   */
  public resolveArtifactPath(taskId: TaskId, fileName: string): string {
    if (!fileName || typeof fileName !== "string" || fileName.trim().length === 0) {
      throw new Error("fileName must be a non-empty string");
    }

    // Reject absolute paths in fileName to prevent system-wide access attempts.
    if (path.isAbsolute(fileName)) {
      throw new Error(`Absolute paths are not allowed in fileName: ${fileName}`);
    }

    const stagingRoot = this.getStagingRoot(taskId);
    
    // Resolve the target absolute path.
    // path.resolve handles both Unix-style '/' and Windows-style '\' separators correctly.
    const targetPath = path.resolve(stagingRoot, fileName);

    // Verify targetPath is strictly inside stagingRoot.
    const relative = path.relative(stagingRoot, targetPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path traversal detected: "${fileName}" escapes staging root.`);
    }

    return targetPath;
  }

  /**
   * Writes the bytes of an artifact file to the staging directory.
   * Automatically creates any necessary parent directories.
   */
  public async writeArtifactFile(
    taskId: TaskId,
    fileName: string,
    bytes: Uint8Array,
  ): Promise<void> {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("bytes must be a Uint8Array");
    }

    const targetPath = this.resolveArtifactPath(taskId, fileName);
    
    // Ensure the parent directory exists.
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    
    // Write file.
    await fs.writeFile(targetPath, bytes);
  }

  /**
   * Reads the bytes of an artifact file from the staging directory.
   */
  public async readArtifactFile(
    taskId: TaskId,
    fileName: string,
  ): Promise<Uint8Array> {
    const targetPath = this.resolveArtifactPath(taskId, fileName);
    
    // Read file bytes.
    const buffer = await fs.readFile(targetPath);
    return new Uint8Array(buffer);
  }

  /**
   * Safely applies a list of specific staging files back to the user's project root.
   * Strictly validates paths to prevent path traversal or writing to forbidden directories
   * (.git, .karo, node_modules, dist, build, coverage).
   *
   * @param taskId The task identifier.
   * @param fileNames Explicit list of file paths relative to the workspace root.
   */
  public async applyToProject(taskId: TaskId, fileNames: string[]): Promise<void> {
    if (!Array.isArray(fileNames)) {
      throw new TypeError("fileNames must be an array of strings");
    }

    const resolvedFiles: { stagingPath: string; projectPath: string }[] = [];

    // Pre-validate all files before doing any writes (fail-fast, atomic validation)
    for (const fileName of fileNames) {
      if (!fileName || typeof fileName !== "string" || fileName.trim().length === 0) {
        throw new Error("fileName must be a non-empty string");
      }

      if (path.isAbsolute(fileName)) {
        throw new Error(`Absolute paths are not allowed in fileName: ${fileName}`);
      }

      // Check for path traversal and resolve inside projectRoot
      const projectPath = path.resolve(this.projectRoot, fileName);
      const relativeToProject = path.relative(this.projectRoot, projectPath);

      if (relativeToProject.startsWith("..") || path.isAbsolute(relativeToProject)) {
        throw new Error(`Path traversal detected: "${fileName}" escapes project root.`);
      }

      // Explicitly reject forbidden directories at any level of the target path
      const parts = relativeToProject.split(path.sep);
      const forbiddenDirs = [".git", ".karo", "node_modules", "dist", "build", "coverage"];
      for (const part of parts) {
        if (forbiddenDirs.includes(part)) {
          throw new Error(`Writing into forbidden directory "${part}" is strictly prohibited.`);
        }
      }

      // Resolve path in staging using the existing safe method
      const stagingPath = this.resolveArtifactPath(taskId, fileName);

      resolvedFiles.push({ stagingPath, projectPath });
    }

    // Physically apply files
    for (const { stagingPath, projectPath } of resolvedFiles) {
      const bytes = await fs.readFile(stagingPath);
      await fs.mkdir(path.dirname(projectPath), { recursive: true });
      await fs.writeFile(projectPath, bytes);
    }
  }

  /**
   * Recursively removes the staging directory for a specific task.
   * Handles Windows-specific file locking issues (EBUSY/EPERM) using robust retries.
   */
  public async cleanStagingDir(taskId: TaskId): Promise<void> {
    const stagingRoot = this.getStagingRoot(taskId);

    let attempts = 3;
    let delay = 100;

    while (attempts > 0) {
      try {
        await fs.rm(stagingRoot, { recursive: true, force: true });
        break;
      } catch (err: any) {
        attempts--;
        // Only retry on Windows-specific locking errors.
        if (attempts === 0 || (err.code !== "EBUSY" && err.code !== "EPERM")) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 3; // Exponential backoff: 100ms, 300ms, 900ms
      }
    }
  }
}
