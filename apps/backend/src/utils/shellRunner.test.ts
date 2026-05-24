import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { ShellRunner } from "./shellRunner.js";

describe("ShellRunner", () => {
  const runner = new ShellRunner();
  const nodeBin = process.execPath;
  const currentDir = process.cwd();

  it("successful command returns exitCode 0 and stdout", async () => {
    const result = await runner.execute({
      command: nodeBin,
      args: ["-e", 'console.log("hello from node")'],
      cwd: currentDir,
      timeoutMs: 5000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim()).toBe("hello from node");
    expect(result.stderr).toBe("");
  });

  it("failing command returns non-zero exitCode and stderr/stdout", async () => {
    const result = await runner.execute({
      command: nodeBin,
      args: ["-e", 'console.error("some error log"); process.exit(42)'],
      cwd: currentDir,
      timeoutMs: 5000,
    });

    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
    expect(result.stderr.trim()).toBe("some error log");
  });

  it("timeout kills long-running process and returns timedOut true", async () => {
    const result = await runner.execute({
      command: nodeBin,
      args: ["-e", "setTimeout(() => {}, 15000)"],
      cwd: currentDir,
      timeoutMs: 200,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("rejects empty command", async () => {
    await expect(
      runner.execute({
        command: "   ",
        args: [],
        cwd: currentDir,
        timeoutMs: 1000,
      })
    ).rejects.toThrow("Command cannot be empty");
  });

  it("rejects non-absolute cwd", async () => {
    await expect(
      runner.execute({
        command: nodeBin,
        args: [],
        cwd: "./relative/path",
        timeoutMs: 1000,
      })
    ).rejects.toThrow("Working directory (cwd) must be an absolute path");
  });

  it("rejects dangerous command metacharacters", async () => {
    await expect(
      runner.execute({
        command: "node; rm -rf /",
        args: [],
        cwd: currentDir,
        timeoutMs: 1000,
      })
    ).rejects.toThrow("Dangerous shell metacharacters detected in command");

    await expect(
      runner.execute({
        command: "node && echo",
        args: [],
        cwd: currentDir,
        timeoutMs: 1000,
      })
    ).rejects.toThrow("Dangerous shell metacharacters detected in command");
  });

  it("does not use shell string execution", async () => {
    // Under a shell, a command like `node` with argument `a && node -e 'console.log("hacked")'`
    // would execute the second node command if shell = true.
    // With shell = false, the entire argument is passed literally to the first node process.
    const result = await runner.execute({
      command: nodeBin,
      args: ["-e", "console.log(process.argv[1])", "first_arg && node -e 'console.log(\"hacked\")'"],
      cwd: currentDir,
      timeoutMs: 5000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("first_arg && node -e 'console.log(\"hacked\")'");
  });

  it("truncates very large output", async () => {
    const result = await runner.execute({
      command: nodeBin,
      args: ["-e", 'console.log("A".repeat(5000))'],
      cwd: currentDir,
      timeoutMs: 5000,
      maxOutputBytes: 15,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(15);
    expect(result.stdout).toBe("A".repeat(15));
  });
});
