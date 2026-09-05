import { spawn } from "node:child_process";
import { chmod, mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { EXIT_CODES, ProvenWayError } from "./errors.js";
import { redact, secretValuesFromEnvironment } from "./redaction.js";

export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs: number;
  maxLogBytes: number;
  signal?: AbortSignal;
  processKey?: string;
  onStdoutLine?: (line: string) => void | Promise<void>;
  onStderrLine?: (line: string) => void | Promise<void>;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  overflowed: boolean;
  pid?: number;
}

const activeProcesses = new Map<string, { pid: number; cancel: () => void }>();

export function registerProcess(key: string, pid: number, cancel: () => void): void {
  activeProcesses.set(key, { pid, cancel });
}

export function unregisterProcess(key: string): void {
  activeProcesses.delete(key);
}

export function cancelRegisteredProcess(key: string): boolean {
  const active = activeProcesses.get(key);
  if (!active) return false;
  active.cancel();
  return true;
}

export function registeredProcessIds(): ReadonlyMap<string, number> {
  return new Map([...activeProcesses].map(([key, value]) => [key, value.pid]));
}

export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  await mkdir(path.dirname(request.stdoutPath), { recursive: true, mode: 0o700 });
  const [stdoutFile, stderrFile] = await Promise.all([
    open(request.stdoutPath, "w", 0o600),
    open(request.stderrPath, "w", 0o600),
  ]);
  await Promise.all([chmod(request.stdoutPath, 0o600), chmod(request.stderrPath, 0o600)]);

  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const env = request.env ?? process.env;
  const secrets = secretValuesFromEnvironment(process.env);
  let stdout = "";
  let stderr = "";
  let stdoutPending = "";
  let stderrPending = "";
  let loggedBytes = 0;
  let timedOut = false;
  let cancelled = false;
  const executionState = { overflowed: false };
  const streamErrors: unknown[] = [];

  const child = spawn(request.executable, request.args, {
    cwd: request.cwd,
    env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });

  const terminate = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    signalProcess(child.pid, "SIGTERM");
    const timer = setTimeout(() => signalProcess(child.pid, "SIGKILL"), 5_000);
    timer.unref();
  };
  if (request.processKey && child.pid !== undefined) {
    registerProcess(request.processKey, child.pid, terminate);
  }

  const abortHandler = (): void => {
    cancelled = true;
    terminate();
  };
  request.signal?.addEventListener("abort", abortHandler, { once: true });
  if (request.signal?.aborted) abortHandler();

  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, request.timeoutMs);
  timeout.unref();

  const consume = async (
    chunk: Buffer,
    file: FileHandle,
    stream: "stdout" | "stderr",
  ): Promise<void> => {
    const clean = redact(chunk.toString("utf8"), secrets);
    loggedBytes += Buffer.byteLength(clean);
    if (loggedBytes > request.maxLogBytes) {
      executionState.overflowed = true;
      terminate();
      return;
    }
    await file.appendFile(clean, "utf8");
    if (stream === "stdout") {
      stdout += clean;
      stdoutPending += clean;
      stdoutPending = await flushLines(stdoutPending, request.onStdoutLine);
    } else {
      stderr += clean;
      stderrPending += clean;
      stderrPending = await flushLines(stderrPending, request.onStderrLine);
    }
  };

  let stdoutChain = Promise.resolve();
  let stderrChain = Promise.resolve();
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutChain = stdoutChain
      .then(() => consume(chunk, stdoutFile, "stdout"))
      .catch((error: unknown) => {
        streamErrors.push(error);
        terminate();
      });
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChain = stderrChain
      .then(() => consume(chunk, stderrFile, "stderr"))
      .catch((error: unknown) => {
        streamErrors.push(error);
        terminate();
      });
  });

  child.stdin.end(request.stdin);

  let outcome: { exitCode: number | null; signal: NodeJS.Signals | null };
  try {
    outcome = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", abortHandler);
    if (request.processKey) unregisterProcess(request.processKey);
    await Promise.allSettled([stdoutChain, stderrChain]);
    if (stdoutPending && request.onStdoutLine) await request.onStdoutLine(stdoutPending);
    if (stderrPending && request.onStderrLine) await request.onStderrLine(stderrPending);
    await Promise.all([stdoutFile.close(), stderrFile.close()]);
  }

  const finished = Date.now();
  const streamError = streamErrors[0];
  if (streamError) {
    throw streamError instanceof Error
      ? streamError
      : new Error(typeof streamError === "string" ? streamError : JSON.stringify(streamError));
  }
  if (executionState.overflowed) {
    throw new ProvenWayError(
      `Process logs exceeded ${request.maxLogBytes} bytes`,
      EXIT_CODES.provider,
      "LOG_LIMIT_EXCEEDED",
    );
  }

  return {
    ...outcome,
    stdout,
    stderr,
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    timedOut,
    cancelled,
    overflowed: executionState.overflowed,
    ...(child.pid !== undefined ? { pid: child.pid } : {}),
  };
}

async function flushLines(
  pending: string,
  callback?: (line: string) => void | Promise<void>,
): Promise<string> {
  if (!callback) return pending;
  const lines = pending.split("\n");
  const remainder = lines.pop() ?? "";
  for (const line of lines) await callback(line);
  return remainder;
}

function signalProcess(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}
