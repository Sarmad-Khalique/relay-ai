import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { VerificationCommand } from "./config.js";
import { sha256 } from "./artifacts.js";
import { resolveExecutable } from "./executable.js";
import { sanitizedProviderEnvironment } from "./redaction.js";
import { runProcess } from "./subprocess.js";
import type { VerificationResult } from "./schemas.js";

export interface VerificationRunOptions {
  taskId: string;
  worktree: string;
  logDirectory: string;
  commands: VerificationCommand[];
  signal?: AbortSignal;
  maxLogBytes: number;
  onOutput?: (command: string, stream: "stdout" | "stderr", line: string) => void;
}

export async function discoverVerificationCommands(
  repositoryRoot: string,
): Promise<VerificationCommand[]> {
  const commands: VerificationCommand[] = [];
  const packageJson = await readJsonIfPresent(path.join(repositoryRoot, "package.json"));
  if (isRecord(packageJson) && isRecord(packageJson.scripts)) {
    const packageManager = await detectPackageManager(repositoryRoot);
    for (const script of ["test", "typecheck", "lint", "build"]) {
      if (typeof packageJson.scripts[script] === "string") {
        commands.push(command(`${packageManager} ${script}`, [packageManager, "run", script]));
      }
    }
  }

  const pyproject = await readTextIfPresent(path.join(repositoryRoot, "pyproject.toml"));
  if (pyproject) {
    if (/\bpytest\b|\[tool\.pytest/i.test(pyproject)) {
      commands.push(command("pytest", ["python", "-m", "pytest"]));
    }
    if (/\bruff\b|\[tool\.ruff/i.test(pyproject))
      commands.push(command("ruff", ["ruff", "check", "."]));
    if (/\bmypy\b|\[tool\.mypy/i.test(pyproject)) commands.push(command("mypy", ["mypy", "."]));
  }

  if (await exists(path.join(repositoryRoot, "Cargo.toml"))) {
    const argv = (await exists(path.join(repositoryRoot, "Cargo.lock")))
      ? ["cargo", "test", "--locked"]
      : ["cargo", "test"];
    commands.push(command("cargo test", argv));
  }
  return deduplicateCommands(commands);
}

export async function describeNetworkEnforcement(
  env: NodeJS.ProcessEnv = process.env,
): Promise<"sandbox-exec" | "bubblewrap" | "unavailable"> {
  if (
    process.platform === "darwin" &&
    (await resolveExecutable("sandbox-exec", ["sandbox-exec"], env))
  ) {
    return "sandbox-exec";
  }
  if (process.platform === "linux" && (await resolveExecutable("bwrap", ["bwrap"], env))) {
    return "bubblewrap";
  }
  return "unavailable";
}

export async function runVerification(
  options: VerificationRunOptions,
): Promise<VerificationResult> {
  const enforcement = await describeNetworkEnforcement();
  const results: VerificationResult["commands"] = [];
  for (const [index, configured] of options.commands.entries()) {
    const [requestedExecutable, ...requestedArgs] = configured.argv;
    if (!requestedExecutable) continue;
    const wrapped = wrapNetworkDenied(enforcement, requestedExecutable, requestedArgs);
    const stdoutPath = path.join(options.logDirectory, `verify-${index + 1}.stdout.log`);
    const stderrPath = path.join(options.logDirectory, `verify-${index + 1}.stderr.log`);
    try {
      const processResult = await runProcess({
        executable: wrapped.executable,
        args: wrapped.args,
        cwd: options.worktree,
        env: sanitizedProviderEnvironment(process.env, false),
        stdoutPath,
        stderrPath,
        timeoutMs: configured.timeout_seconds * 1_000,
        maxLogBytes: options.maxLogBytes,
        ...(options.signal ? { signal: options.signal } : {}),
        processKey: options.taskId,
        onStdoutLine: (line) => options.onOutput?.(configured.name, "stdout", line),
        onStderrLine: (line) => options.onOutput?.(configured.name, "stderr", line),
      });
      results.push({
        name: configured.name,
        argv: configured.argv as [string, ...string[]],
        required: configured.required,
        started_at: processResult.startedAt,
        finished_at: processResult.finishedAt,
        duration_ms: processResult.durationMs,
        exit_code: processResult.exitCode,
        signal: processResult.signal,
        timed_out: processResult.timedOut,
        cancelled: processResult.cancelled,
        stdout_sha256: sha256(processResult.stdout),
        stderr_sha256: sha256(processResult.stderr),
      });
    } catch (error) {
      const now = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        name: configured.name,
        argv: configured.argv as [string, ...string[]],
        required: configured.required,
        started_at: now,
        finished_at: now,
        duration_ms: 0,
        exit_code: null,
        signal: null,
        timed_out: /timed out/i.test(message),
        cancelled: /cancel/i.test(message),
        stdout_sha256: sha256(""),
        stderr_sha256: sha256(message),
      });
    }
  }
  return {
    schema_version: "1.0",
    task_id: options.taskId,
    passed: results.every((result) => !result.required || result.exit_code === 0),
    commands: results,
  };
}

export function mergeVerificationCommands(
  configured: readonly VerificationCommand[],
  discovered: readonly VerificationCommand[],
): VerificationCommand[] {
  return deduplicateCommands([...configured, ...discovered]);
}

function wrapNetworkDenied(
  enforcement: "sandbox-exec" | "bubblewrap" | "unavailable",
  executable: string,
  args: string[],
): { executable: string; args: string[] } {
  if (enforcement === "sandbox-exec") {
    return {
      executable: "/usr/bin/sandbox-exec",
      args: ["-p", "(version 1) (allow default) (deny network*)", executable, ...args],
    };
  }
  if (enforcement === "bubblewrap") {
    return {
      executable: "bwrap",
      args: ["--dev-bind", "/", "/", "--unshare-net", "--", executable, ...args],
    };
  }
  return { executable, args };
}

function command(name: string, argv: string[]): VerificationCommand {
  return { name, argv, timeout_seconds: 900, required: true };
}

function deduplicateCommands(commands: readonly VerificationCommand[]): VerificationCommand[] {
  const seen = new Set<string>();
  return commands.filter((candidate) => {
    const key = JSON.stringify(candidate.argv);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function detectPackageManager(repositoryRoot: string): Promise<"pnpm" | "yarn" | "npm"> {
  if (await exists(path.join(repositoryRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(repositoryRoot, "yarn.lock"))) return "yarn";
  return "npm";
}

async function readJsonIfPresent(file: string): Promise<unknown> {
  const value = await readTextIfPresent(file);
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

async function readTextIfPresent(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
