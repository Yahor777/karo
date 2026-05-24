import { spawn } from "node:child_process";
import * as path from "node:path";

export interface ShellExecuteInput {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes?: number;
}

export interface ShellExecuteResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  command: string;
  args: string[];
  cwd: string;
}

export class ShellRunner {
  /**
   * Executes a command with arguments in a specified absolute directory (cwd).
   * Enforces safety: prevents dangerous shell characters, non-absolute paths,
   * handles timeouts with SIGKILL, and caps output buffer size to prevent memory exhaust.
   */
  public async execute(input: ShellExecuteInput): Promise<ShellExecuteResult> {
    const { command, args, cwd, timeoutMs, maxOutputBytes = 1024 * 1024 } = input;

    // 1. Validations
    if (!command || command.trim() === "") {
      throw new Error("Command cannot be empty");
    }

    if (!cwd || cwd.trim() === "") {
      throw new Error("Working directory (cwd) cannot be empty");
    }

    if (!path.isAbsolute(cwd)) {
      throw new Error(`Working directory (cwd) must be an absolute path: ${cwd}`);
    }

    if (timeoutMs <= 0) {
      throw new Error(`Timeout must be a positive integer: ${timeoutMs}`);
    }

    // Dangerous shell metacharacters: &, |, ;, >, <, &&, ||
    const dangerousPattern = /[&|;><]/;
    if (dangerousPattern.test(command)) {
      throw new Error(`Dangerous shell metacharacters detected in command: "${command}"`);
    }

    // 2. Windows Executable Resolution
    let effectiveCommand = command;
    if (process.platform === "win32") {
      const isWindowsCmdExecutable = ["pnpm", "npm", "yarn", "npx", "vitest"].includes(
        command.toLowerCase()
      );
      if (isWindowsCmdExecutable) {
        effectiveCommand = `${command}.cmd`;
      }
    }

    // 3. Spawning the child process
    return new Promise((resolve) => {
      let timedOut = false;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;

      const child = spawn(effectiveCommand, args, {
        cwd,
        shell: false,
      });

      // Handle child process startup errors (e.g. command not found)
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          exitCode: null,
          timedOut: false,
          stdout: "",
          stderr: `Failed to spawn process: ${err.message}`,
          command,
          args,
          cwd,
        });
      });

      // Setup Timeout
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // Swallow kill errors if process already died
        }
      }, timeoutMs);

      // Read stdout safely up to maxOutputBytes limit
      if (child.stdout) {
        child.stdout.on("data", (chunk: Buffer) => {
          if (stdoutBytes < maxOutputBytes) {
            const remaining = maxOutputBytes - stdoutBytes;
            if (chunk.length > remaining) {
              stdoutChunks.push(chunk.subarray(0, remaining));
              stdoutBytes += remaining;
            } else {
              stdoutChunks.push(chunk);
              stdoutBytes += chunk.length;
            }
          }
        });
      }

      // Read stderr safely up to maxOutputBytes limit
      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderrBytes < maxOutputBytes) {
            const remaining = maxOutputBytes - stderrBytes;
            if (chunk.length > remaining) {
              stderrChunks.push(chunk.subarray(0, remaining));
              stderrBytes += remaining;
            } else {
              stderrChunks.push(chunk);
              stderrBytes += chunk.length;
            }
          }
        });
      }

      // Handle completion
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: timedOut ? null : code,
          timedOut,
          stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
          stderr: Buffer.concat(stderrChunks).toString("utf-8"),
          command,
          args,
          cwd,
        });
      });
    });
  }
}
