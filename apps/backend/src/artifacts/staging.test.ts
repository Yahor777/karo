import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { StagingWorkspaceManager } from "./staging.js";

const TEST_PROJECT_ROOT = path.resolve(process.cwd(), ".karo", "test-run-staging");
const TASK_A = "task-a";
const TASK_B = "task-b";

describe("StagingWorkspaceManager", () => {
  const manager = new StagingWorkspaceManager(TEST_PROJECT_ROOT);

  beforeEach(async () => {
    // Clean up the entire test staging directory before each test.
    await fs.rm(TEST_PROJECT_ROOT, { recursive: true, force: true });
  });

  afterAll(async () => {
    // Final cleanup after all tests are done.
    await fs.rm(TEST_PROJECT_ROOT, { recursive: true, force: true });
  });

  it("creates staging dir under .karo/staging/<task-id>", async () => {
    const stagingRoot = manager.getStagingRoot(TASK_A);
    expect(stagingRoot).toBe(path.resolve(TEST_PROJECT_ROOT, ".karo", "staging", TASK_A));

    await manager.ensureStagingDir(TASK_A);

    // Verify directory exists on disk.
    const stat = await fs.stat(stagingRoot);
    expect(stat.isDirectory()).toBe(true);
  });

  it("writes nested file src/utils/math.ts", async () => {
    await manager.ensureStagingDir(TASK_A);
    const content = new TextEncoder().encode("export const add = (a, b) => a + b;");
    const fileName = "src/utils/math.ts";

    await manager.writeArtifactFile(TASK_A, fileName, content);

    // Verify it resolved properly and exists.
    const resolvedPath = manager.resolveArtifactPath(TASK_A, fileName);
    expect(resolvedPath).toBe(path.resolve(manager.getStagingRoot(TASK_A), "src", "utils", "math.ts"));

    const fileContent = await manager.readArtifactFile(TASK_A, fileName);
    expect(new TextDecoder().decode(fileContent)).toBe("export const add = (a, b) => a + b;");
  });

  it("overwrites existing file", async () => {
    await manager.ensureStagingDir(TASK_A);
    const fileName = "config.json";
    
    await manager.writeArtifactFile(TASK_A, fileName, new TextEncoder().encode("v1"));
    let content = await manager.readArtifactFile(TASK_A, fileName);
    expect(new TextDecoder().decode(content)).toBe("v1");

    await manager.writeArtifactFile(TASK_A, fileName, new TextEncoder().encode("v2"));
    content = await manager.readArtifactFile(TASK_A, fileName);
    expect(new TextDecoder().decode(content)).toBe("v2");
  });

  it("rejects ../evil.ts", async () => {
    await manager.ensureStagingDir(TASK_A);
    
    expect(() => {
      manager.resolveArtifactPath(TASK_A, "../evil.ts");
    }).toThrow("Path traversal detected");

    expect(() => {
      manager.resolveArtifactPath(TASK_A, "src/../../evil.ts");
    }).toThrow("Path traversal detected");
  });

  it("rejects absolute path", async () => {
    await manager.ensureStagingDir(TASK_A);

    const absolutePath = path.resolve(TEST_PROJECT_ROOT, "evil.ts");
    expect(() => {
      manager.resolveArtifactPath(TASK_A, absolutePath);
    }).toThrow("Absolute paths are not allowed");
  });

  it("task A does not affect task B", async () => {
    await manager.ensureStagingDir(TASK_A);
    await manager.ensureStagingDir(TASK_B);

    const contentA = new TextEncoder().encode("Content A");
    const contentB = new TextEncoder().encode("Content B");

    await manager.writeArtifactFile(TASK_A, "shared.txt", contentA);
    await manager.writeArtifactFile(TASK_B, "shared.txt", contentB);

    const readA = await manager.readArtifactFile(TASK_A, "shared.txt");
    const readB = await manager.readArtifactFile(TASK_B, "shared.txt");

    expect(new TextDecoder().decode(readA)).toBe("Content A");
    expect(new TextDecoder().decode(readB)).toBe("Content B");
  });

  it("cleanStagingDir removes only selected task dir", async () => {
    await manager.ensureStagingDir(TASK_A);
    await manager.ensureStagingDir(TASK_B);

    await manager.writeArtifactFile(TASK_A, "file.txt", new TextEncoder().encode("A"));
    await manager.writeArtifactFile(TASK_B, "file.txt", new TextEncoder().encode("B"));

    await manager.cleanStagingDir(TASK_A);

    // Task A dir should be gone.
    await expect(fs.stat(manager.getStagingRoot(TASK_A))).rejects.toThrow();

    // Task B dir should still exist.
    const statB = await fs.stat(manager.getStagingRoot(TASK_B));
    expect(statB.isDirectory()).toBe(true);
    
    const readB = await manager.readArtifactFile(TASK_B, "file.txt");
    expect(new TextDecoder().decode(readB)).toBe("B");
  });

  it("resolveArtifactPath never escapes staging root", () => {
    const stagingRoot = manager.getStagingRoot(TASK_A);

    // Safe nested path
    const resolved = manager.resolveArtifactPath(TASK_A, "nested/deep/file.txt");
    expect(resolved.startsWith(stagingRoot)).toBe(true);

    // Dangerous paths
    expect(() => manager.resolveArtifactPath(TASK_A, "../file.txt")).toThrow();
    expect(() => manager.resolveArtifactPath(TASK_A, "nested/../../../file.txt")).toThrow();
    expect(() => manager.resolveArtifactPath(TASK_A, "\\..\\file.txt")).toThrow();
    expect(() => manager.resolveArtifactPath(TASK_A, "/absolute/path")).toThrow();
  });

  describe("initializeWorkspace", () => {
    async function setupMockProject() {
      await fs.mkdir(path.join(TEST_PROJECT_ROOT, "src", "utils"), { recursive: true });
      await fs.mkdir(path.join(TEST_PROJECT_ROOT, "node_modules", "lodash"), { recursive: true });
      await fs.mkdir(path.join(TEST_PROJECT_ROOT, ".git"), { recursive: true });
      await fs.mkdir(path.join(TEST_PROJECT_ROOT, ".karo"), { recursive: true });
      await fs.mkdir(path.join(TEST_PROJECT_ROOT, "dist"), { recursive: true });
      await fs.mkdir(path.join(TEST_PROJECT_ROOT, "build"), { recursive: true });

      await fs.writeFile(path.join(TEST_PROJECT_ROOT, "package.json"), "{}");
      await fs.writeFile(path.join(TEST_PROJECT_ROOT, "src", "index.ts"), "console.log('hello');");
      await fs.writeFile(path.join(TEST_PROJECT_ROOT, "src", "utils", "math.ts"), "export const add = (a, b) => a + b;");
      await fs.writeFile(path.join(TEST_PROJECT_ROOT, "node_modules", "lodash", "index.js"), "module.exports = {};");
      await fs.writeFile(path.join(TEST_PROJECT_ROOT, ".git", "config"), "git-config");
      await fs.writeFile(path.join(TEST_PROJECT_ROOT, ".karo", "config.json"), "karo-config");
      await fs.writeFile(path.join(TEST_PROJECT_ROOT, "dist", "bundle.js"), "dist-js");
      await fs.writeFile(path.join(TEST_PROJECT_ROOT, "build", "index.js"), "build-js");
      await fs.writeFile(path.join(TEST_PROJECT_ROOT, "test.log"), "log-content");
    }

    it("initializeWorkspace copies project files into staging", async () => {
      await setupMockProject();

      const stagingRoot = await manager.initializeWorkspace(TASK_A);

      expect(stagingRoot).toBe(manager.getStagingRoot(TASK_A));

      const pkgJson = await fs.readFile(path.join(stagingRoot, "package.json"), "utf8");
      expect(pkgJson).toBe("{}");

      const indexTs = await fs.readFile(path.join(stagingRoot, "src", "index.ts"), "utf8");
      expect(indexTs).toBe("console.log('hello');");

      const mathTs = await fs.readFile(path.join(stagingRoot, "src", "utils", "math.ts"), "utf8");
      expect(mathTs).toBe("export const add = (a, b) => a + b;");
    });

    it("initializeWorkspace excludes .git, .karo, node_modules, dist, build", async () => {
      await setupMockProject();

      const stagingRoot = await manager.initializeWorkspace(TASK_A);

      // Verify excluded folders/files do not exist in staging root.
      // Note: node_modules will be checked separately since it is created as a symlink/junction.
      await expect(fs.stat(path.join(stagingRoot, ".git"))).rejects.toThrow();
      await expect(fs.stat(path.join(stagingRoot, "dist"))).rejects.toThrow();
      await expect(fs.stat(path.join(stagingRoot, "build"))).rejects.toThrow();
      await expect(fs.stat(path.join(stagingRoot, "test.log"))).rejects.toThrow();

      // Only the task staging folder itself should exist under .karo inside stagingRoot,
      // but the copied .karo folder from the mock project root should NOT be copied.
      // Let's verify that other subdirectories of .karo (like .karo/config.json) are not copied.
      await expect(fs.stat(path.join(stagingRoot, ".karo", "config.json"))).rejects.toThrow();
    });

    it("initializeWorkspace does not recursively copy staging into itself", async () => {
      await setupMockProject();

      // Ensure directory for staging is created first
      await manager.ensureStagingDir(TASK_A);
      const stagingRoot = manager.getStagingRoot(TASK_A);

      // Write a dummy file inside the staging area before workspace initialization
      await fs.mkdir(path.dirname(path.join(stagingRoot, "dummy.txt")), { recursive: true });
      await fs.writeFile(path.join(stagingRoot, "dummy.txt"), "staged");

      // Run initialization
      await manager.initializeWorkspace(TASK_A);

      // Verify that the staging root does not contain another recursive copy of .karo/staging/task-a
      const nestedStaging = path.join(stagingRoot, ".karo", "staging", TASK_A);
      await expect(fs.stat(nestedStaging)).rejects.toThrow();
    });

    it("initializeWorkspace creates node_modules junction/symlink when node_modules exists", async () => {
      await setupMockProject();

      const stagingRoot = await manager.initializeWorkspace(TASK_A);
      const stagingNodeModules = path.join(stagingRoot, "node_modules");

      const stats = await fs.lstat(stagingNodeModules);
      expect(stats.isSymbolicLink()).toBe(true);

      // Verify dependencies are accessible through the link
      const lodashIndex = await fs.readFile(path.join(stagingNodeModules, "lodash", "index.js"), "utf8");
      expect(lodashIndex).toBe("module.exports = {};");
    });

    it("initializeWorkspace does not fail when node_modules is missing", async () => {
      // Setup mock project WITHOUT node_modules
      await fs.mkdir(path.join(TEST_PROJECT_ROOT, "src"), { recursive: true });
      await fs.writeFile(path.join(TEST_PROJECT_ROOT, "package.json"), "{}");

      const stagingRoot = await manager.initializeWorkspace(TASK_A);
      
      const pkgJson = await fs.readFile(path.join(stagingRoot, "package.json"), "utf8");
      expect(pkgJson).toBe("{}");

      // node_modules should not be present in staging
      await expect(fs.lstat(path.join(stagingRoot, "node_modules"))).rejects.toThrow();
    });

    it("repeated initializeWorkspace call is safe", async () => {
      await setupMockProject();

      // First initialization
      await manager.initializeWorkspace(TASK_A);

      // Modify original project: add a new file and delete an old file
      await fs.writeFile(path.join(TEST_PROJECT_ROOT, "src", "new.ts"), "new");
      await fs.rm(path.join(TEST_PROJECT_ROOT, "package.json"));

      // Second initialization
      const stagingRoot = await manager.initializeWorkspace(TASK_A);

      // New file should be copied
      const newFile = await fs.readFile(path.join(stagingRoot, "src", "new.ts"), "utf8");
      expect(newFile).toBe("new");

      // Deleted file should no longer be present (due to directory recreation)
      await expect(fs.stat(path.join(stagingRoot, "package.json"))).rejects.toThrow();
    });
  });

  describe("applyToProject", () => {
    it("applies explicit changed file from staging to project", async () => {
      // Setup minimal project and staging files
      await fs.mkdir(path.join(TEST_PROJECT_ROOT, "src"), { recursive: true });
      await fs.writeFile(path.join(TEST_PROJECT_ROOT, "src", "main.ts"), "original");

      await manager.ensureStagingDir(TASK_A);
      await manager.writeArtifactFile(TASK_A, "src/main.ts", new TextEncoder().encode("updated"));

      // Run apply
      await manager.applyToProject(TASK_A, ["src/main.ts"]);

      // Verify
      const content = await fs.readFile(path.join(TEST_PROJECT_ROOT, "src", "main.ts"), "utf8");
      expect(content).toBe("updated");
    });

    it("creates nested directories in project", async () => {
      await manager.ensureStagingDir(TASK_A);
      await manager.writeArtifactFile(TASK_A, "src/nested/deep/file.ts", new TextEncoder().encode("nested-data"));

      await manager.applyToProject(TASK_A, ["src/nested/deep/file.ts"]);

      const content = await fs.readFile(path.join(TEST_PROJECT_ROOT, "src", "nested", "deep", "file.ts"), "utf8");
      expect(content).toBe("nested-data");
    });

    it("rejects ../evil.ts", async () => {
      await manager.ensureStagingDir(TASK_A);
      await expect(
        manager.applyToProject(TASK_A, ["../evil.ts"])
      ).rejects.toThrow("Path traversal detected");
    });

    it("rejects absolute path", async () => {
      await manager.ensureStagingDir(TASK_A);
      const absolutePath = path.resolve(TEST_PROJECT_ROOT, "evil.ts");
      await expect(
        manager.applyToProject(TASK_A, [absolutePath])
      ).rejects.toThrow("Absolute paths are not allowed");
    });

    it("rejects writes into .git", async () => {
      await manager.ensureStagingDir(TASK_A);
      await expect(
        manager.applyToProject(TASK_A, [".git/config"])
      ).rejects.toThrow("Writing into forbidden directory");
    });

    it("rejects writes into .karo", async () => {
      await manager.ensureStagingDir(TASK_A);
      await expect(
        manager.applyToProject(TASK_A, [".karo/config.json"])
      ).rejects.toThrow("Writing into forbidden directory");
    });

    it("rejects writes into node_modules", async () => {
      await manager.ensureStagingDir(TASK_A);
      await expect(
        manager.applyToProject(TASK_A, ["node_modules/lodash/index.js"])
      ).rejects.toThrow("Writing into forbidden directory");
    });

    it("does not copy unrelated staging files", async () => {
      await fs.mkdir(path.join(TEST_PROJECT_ROOT, "src"), { recursive: true });
      await fs.writeFile(path.join(TEST_PROJECT_ROOT, "src", "main.ts"), "original-main");

      await manager.ensureStagingDir(TASK_A);
      await manager.writeArtifactFile(TASK_A, "src/main.ts", new TextEncoder().encode("updated-main"));
      await manager.writeArtifactFile(TASK_A, "src/other.ts", new TextEncoder().encode("unrelated"));

      // Only apply src/main.ts
      await manager.applyToProject(TASK_A, ["src/main.ts"]);

      // Verify main.ts is updated
      const mainContent = await fs.readFile(path.join(TEST_PROJECT_ROOT, "src", "main.ts"), "utf8");
      expect(mainContent).toBe("updated-main");

      // Verify other.ts is NOT copied back to project
      await expect(fs.stat(path.join(TEST_PROJECT_ROOT, "src", "other.ts"))).rejects.toThrow();
    });

    it("does not copy full workspace back to project", async () => {
      // Verify that applyToProject only copies the files explicitly passed
      await fs.mkdir(path.join(TEST_PROJECT_ROOT, "src"), { recursive: true });
      await fs.writeFile(path.join(TEST_PROJECT_ROOT, "src", "main.ts"), "original");

      await manager.ensureStagingDir(TASK_A);
      await manager.writeArtifactFile(TASK_A, "src/main.ts", new TextEncoder().encode("updated"));
      await manager.writeArtifactFile(TASK_A, "package.json", new TextEncoder().encode("{}"));

      // Call apply with an empty list
      await manager.applyToProject(TASK_A, []);

      // package.json should NOT be copied back
      await expect(fs.stat(path.join(TEST_PROJECT_ROOT, "package.json"))).rejects.toThrow();

      // src/main.ts should NOT be copied back either
      const mainContent = await fs.readFile(path.join(TEST_PROJECT_ROOT, "src", "main.ts"), "utf8");
      expect(mainContent).toBe("original");
    });
  });
});

