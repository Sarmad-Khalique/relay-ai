import { execFile as execFileCallback } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export async function resolveExecutable(
  configured: string,
  candidates: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const choices = configured === "auto" ? candidates : [configured];
  for (const choice of choices) {
    if (choice.includes(path.sep)) {
      try {
        await access(path.resolve(choice));
        return path.resolve(choice);
      } catch {
        continue;
      }
    }
    const pathValue = env.PATH ?? "";
    for (const directory of pathValue.split(path.delimiter)) {
      if (!directory) continue;
      const candidate = path.join(directory, choice);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  return undefined;
}

export async function captureCommand(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFile(executable, args, {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    if (isExecError(error)) {
      return {
        stdout: typeof error.stdout === "string" ? error.stdout : "",
        stderr: typeof error.stderr === "string" ? error.stderr : error.message,
        exitCode: typeof error.code === "number" ? error.code : 1,
      };
    }
    throw error;
  }
}

function isExecError(
  error: unknown,
): error is Error & { stdout?: string; stderr?: string; code?: number | string } {
  return error instanceof Error;
}
