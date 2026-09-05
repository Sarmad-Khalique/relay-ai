import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  EventSink,
  HarnessAdapter,
  HarnessResumeRequest,
  HarnessRunRequest,
  HarnessRunResult,
  NormalizedHarnessEvent,
  ProbeContext,
  ProviderCapabilities,
} from "../adapter-contract.js";
import { EXIT_CODES, RelayError } from "../errors.js";
import { captureCommand, resolveExecutable } from "../executable.js";
import { sanitizedProviderEnvironment } from "../redaction.js";
import { runProcess } from "../subprocess.js";

export class CodexAdapter implements HarnessAdapter {
  readonly id = "codex";
  private executable?: string;

  constructor(private readonly configuredExecutable = "codex") {}

  async probe(ctx: ProbeContext): Promise<ProviderCapabilities> {
    const executable = await resolveExecutable(
      ctx.executable ?? this.configuredExecutable,
      ["codex"],
      ctx.env,
    );
    if (!executable) return unavailable("Codex CLI was not found on PATH");
    this.executable = executable;
    const [version, help, auth] = await Promise.all([
      captureCommand(executable, ["--version"], ctx.cwd, ctx.env),
      captureCommand(executable, ["exec", "--help"], ctx.cwd, ctx.env),
      captureCommand(executable, ["login", "status"], ctx.cwd, ctx.env),
    ]);
    const helpText = `${help.stdout}\n${help.stderr}`;
    const authText = `${auth.stdout}\n${auth.stderr}`;
    const requiredFlags = [
      "--json",
      "--output-schema",
      "--output-last-message",
      "--sandbox",
      "--ephemeral",
      "--ignore-user-config",
    ];
    const missing = requiredFlags.filter((flag) => !helpText.includes(flag));
    let availableModels: string[] | undefined;
    if (ctx.deep) {
      const models = await captureCommand(
        executable,
        ["debug", "models", "--bundled"],
        ctx.cwd,
        ctx.env,
      );
      availableModels = parseModelCatalog(models.stdout);
    }
    const parsedVersion = firstLine(version.stdout || version.stderr);
    return {
      installed: version.exitCode === 0,
      executable,
      ...(parsedVersion ? { version: parsedVersion } : {}),
      authenticated: auth.exitCode === 0,
      authMode: authMode(authText),
      models: availableModels?.length ? "discoverable" : "configured-only",
      ...(availableModels?.length ? { availableModels } : {}),
      supportsJsonEvents: helpText.includes("--json"),
      supportsOutputSchema: helpText.includes("--output-schema"),
      supportsResume: helpText.includes("resume"),
      permissionModes: helpText.includes("read-only") ? ["read-only", "workspace-write"] : [],
      warnings: missing.map((flag) => `Missing required Codex flag: ${flag}`),
    };
  }

  async start(request: HarnessRunRequest, sink: EventSink): Promise<HarnessRunResult> {
    return this.execute(request, sink);
  }

  async resume(request: HarnessResumeRequest, sink: EventSink): Promise<HarnessRunResult> {
    return this.execute(request, sink, request.sessionId);
  }

  async cancel(runId: string): Promise<void> {
    const { cancelRegisteredProcess } = await import("../subprocess.js");
    cancelRegisteredProcess(runId);
  }

  private async execute(
    request: HarnessRunRequest,
    sink: EventSink,
    resumeSessionId?: string,
  ): Promise<HarnessRunResult> {
    const executable =
      this.executable ?? (await resolveExecutable(this.configuredExecutable, ["codex"]));
    if (!executable) throw unavailableError();
    const outputFile =
      request.outputFile ?? path.join(request.logDirectory, `${request.stage}.final.txt`);
    const args = ["exec"];
    if (resumeSessionId) args.push("resume", resumeSessionId);
    args.push(
      "--ignore-user-config",
      "--ephemeral",
      "--model",
      request.model,
      "--sandbox",
      request.permissionMode === "read-only" ? "read-only" : "workspace-write",
      "--json",
      "--output-last-message",
      outputFile,
    );
    if (!resumeSessionId && request.schemaPath) args.push("--output-schema", request.schemaPath);
    if (request.reasoning) args.push("-c", `model_reasoning_effort="${request.reasoning}"`);
    args.push("-C", request.cwd, "-");

    const events: NormalizedHarnessEvent[] = [];
    let sessionId: string | undefined;
    const result = await runProcess({
      executable,
      args,
      cwd: request.cwd,
      env: sanitizedProviderEnvironment(process.env, request.config.policy.allow_payg),
      stdin: request.prompt,
      stdoutPath: path.join(request.logDirectory, `${request.stage}.stdout.ndjson`),
      stderrPath: path.join(request.logDirectory, `${request.stage}.stderr.log`),
      timeoutMs: request.timeoutMs,
      maxLogBytes: request.maxLogBytes,
      ...(request.signal ? { signal: request.signal } : {}),
      processKey: request.runId,
      onStdoutLine: async (line) => {
        if (!line.trim()) return;
        if (Buffer.byteLength(line) > request.maxEventBytes) {
          throw new RelayError(
            "Codex emitted an oversized JSONL event",
            EXIT_CODES.provider,
            "EVENT_LIMIT_EXCEEDED",
          );
        }
        const event = normalizeCodexEvent(line);
        if (event.sessionId) sessionId = event.sessionId;
        events.push(event);
        await sink.emit(event);
      },
    });
    if (result.cancelled)
      throw new RelayError("Codex run cancelled", EXIT_CODES.cancelled, "CANCELLED");
    if (result.timedOut)
      throw new RelayError("Codex run timed out", EXIT_CODES.provider, "PROVIDER_TIMEOUT");
    if (result.exitCode !== 0) throw providerFailure("Codex", result.stderr);

    let finalText: string;
    try {
      finalText = await readFile(outputFile, "utf8");
    } catch {
      finalText = finalTextFromEvents(events);
    }
    return {
      adapterId: this.id,
      executable,
      args,
      ...(sessionId ? { sessionId } : {}),
      finalText,
      exitCode: result.exitCode,
      signal: result.signal,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      stdoutPath: path.join(request.logDirectory, `${request.stage}.stdout.ndjson`),
      stderrPath: path.join(request.logDirectory, `${request.stage}.stderr.log`),
      events,
    };
  }
}

export function normalizeCodexEvent(line: string): NormalizedHarnessEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    raw = { text: line };
  }
  const record = isRecord(raw) ? raw : {};
  const externalType = typeof record.type === "string" ? record.type : "unknown";
  const type =
    externalType === "thread.started"
      ? "init"
      : externalType.includes("item")
        ? externalType.includes("completed")
          ? "tool_completed"
          : "tool_started"
        : externalType === "turn.completed"
          ? "result"
          : externalType === "message"
            ? "message"
            : "unknown";
  const candidateSession = record.thread_id ?? record.session_id;
  return {
    type,
    timestamp: new Date().toISOString(),
    ...(typeof candidateSession === "string" ? { sessionId: candidateSession } : {}),
    payload: raw,
    raw,
  };
}

function unavailable(message: string): ProviderCapabilities {
  return {
    installed: false,
    authenticated: false,
    models: "configured-only",
    supportsJsonEvents: false,
    supportsOutputSchema: false,
    supportsResume: false,
    permissionModes: [],
    warnings: [message],
  };
}

function unavailableError(): RelayError {
  return new RelayError("Codex CLI was not found", EXIT_CODES.environment, "CODEX_NOT_FOUND");
}

function providerFailure(provider: string, stderr: string): RelayError {
  if (/quota|rate.?limit|usage.?limit/i.test(stderr)) {
    return new RelayError(
      `${provider} quota or rate limit reached`,
      EXIT_CODES.awaitingUser,
      "PROVIDER_QUOTA",
    );
  }
  if (/auth|login|unauthorized|forbidden/i.test(stderr)) {
    return new RelayError(
      `${provider} is not authenticated`,
      EXIT_CODES.environment,
      "PROVIDER_AUTH",
    );
  }
  return new RelayError(
    `${provider} exited unsuccessfully: ${stderr.trim() || "no error text"}`,
    EXIT_CODES.provider,
    "PROVIDER_FAILED",
  );
}

function authMode(output: string): "account" | "api-key" | "unknown" {
  if (/chatgpt|account|oauth/i.test(output)) return "account";
  if (/api.?key/i.test(output)) return "api-key";
  return "unknown";
}

function parseModelCatalog(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    const values = new Set<string>();
    collectModelIds(parsed, values);
    return [...values].sort();
  } catch {
    return [];
  }
}

function collectModelIds(value: unknown, target: Set<string>): void {
  if (Array.isArray(value)) {
    for (const child of value) collectModelIds(child, target);
  } else if (isRecord(value)) {
    for (const key of ["slug", "id", "model"]) {
      if (typeof value[key] === "string") target.add(value[key]);
    }
    for (const child of Object.values(value)) collectModelIds(child, target);
  }
}

function finalTextFromEvents(events: NormalizedHarnessEvent[]): string {
  const result = [...events]
    .reverse()
    .find((event) => event.type === "result" || event.type === "message");
  return result ? JSON.stringify(result.payload) : "";
}

function firstLine(value: string): string | undefined {
  return value.trim().split("\n")[0] || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
