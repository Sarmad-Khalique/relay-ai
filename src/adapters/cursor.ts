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

export class CursorAdapter implements HarnessAdapter {
  readonly id = "cursor";
  private executable?: string;

  constructor(private readonly configuredExecutable = "auto") {}

  async probe(ctx: ProbeContext): Promise<ProviderCapabilities> {
    const executable = await resolveExecutable(
      ctx.executable ?? this.configuredExecutable,
      ["agent", "cursor-agent"],
      ctx.env,
    );
    if (!executable) return unavailable("Cursor Agent CLI was not found on PATH");
    this.executable = executable;
    const [version, help, auth] = await Promise.all([
      captureCommand(executable, ["--version"], ctx.cwd, ctx.env),
      captureCommand(executable, ["--help"], ctx.cwd, ctx.env),
      captureCommand(executable, ["status", "--format", "json"], ctx.cwd, ctx.env),
    ]);
    const helpText = `${help.stdout}\n${help.stderr}`;
    const authText = `${auth.stdout}\n${auth.stderr}`;
    const requiredFlags = ["--print", "--output-format", "--model", "--sandbox", "--workspace"];
    const missing = requiredFlags.filter((flag) => !helpText.includes(flag));
    let availableModels: string[] | undefined;
    if (ctx.deep) {
      const models = await captureCommand(executable, ["models"], ctx.cwd, ctx.env);
      availableModels = parseCursorModels(models.stdout);
    }
    const parsedVersion = firstLine(version.stdout || version.stderr);
    return {
      installed: version.exitCode === 0,
      executable,
      ...(parsedVersion ? { version: parsedVersion } : {}),
      authenticated: auth.exitCode === 0 && !/not authenticated|logged out/i.test(authText),
      authMode: /api.?key/i.test(authText)
        ? "api-key"
        : auth.exitCode === 0
          ? "account"
          : "unknown",
      models: availableModels?.length ? "discoverable" : "configured-only",
      ...(availableModels?.length ? { availableModels } : {}),
      supportsJsonEvents: helpText.includes("stream-json"),
      supportsOutputSchema: false,
      supportsResume: helpText.includes("--resume"),
      permissionModes: helpText.includes("--sandbox") ? ["workspace-write"] : [],
      warnings: missing.map((flag) => `Missing required Cursor flag: ${flag}`),
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
      this.executable ??
      (await resolveExecutable(this.configuredExecutable, ["agent", "cursor-agent"]));
    if (!executable) {
      throw new RelayError(
        "Cursor Agent CLI was not found",
        EXIT_CODES.environment,
        "CURSOR_NOT_FOUND",
      );
    }
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--model",
      request.model,
      "--sandbox",
      "enabled",
      "--trust",
      "--force",
      "--workspace",
      request.cwd,
    ];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    args.push(request.prompt);

    const events: NormalizedHarnessEvent[] = [];
    let sessionId: string | undefined;
    let finalText = "";
    let reportedApiSource: string | undefined;
    const stdoutPath = path.join(request.logDirectory, `${request.stage}.stdout.ndjson`);
    const stderrPath = path.join(request.logDirectory, `${request.stage}.stderr.log`);
    const result = await runProcess({
      executable,
      args,
      cwd: request.cwd,
      env: sanitizedProviderEnvironment(process.env, request.config.policy.allow_payg),
      stdoutPath,
      stderrPath,
      timeoutMs: request.timeoutMs,
      maxLogBytes: request.maxLogBytes,
      ...(request.signal ? { signal: request.signal } : {}),
      processKey: request.runId,
      onStdoutLine: async (line) => {
        if (!line.trim()) return;
        if (Buffer.byteLength(line) > request.maxEventBytes) {
          throw new RelayError(
            "Cursor emitted an oversized JSONL event",
            EXIT_CODES.provider,
            "EVENT_LIMIT_EXCEEDED",
          );
        }
        const event = normalizeCursorEvent(line);
        if (event.sessionId) sessionId = event.sessionId;
        if (
          event.type === "init" &&
          isRecord(event.raw) &&
          typeof event.raw.apiKeySource === "string"
        ) {
          reportedApiSource = event.raw.apiKeySource;
        }
        if (
          event.type === "result" &&
          isRecord(event.raw) &&
          typeof event.raw.result === "string"
        ) {
          finalText = event.raw.result;
        }
        events.push(event);
        await sink.emit(event);
      },
    });
    if (result.cancelled)
      throw new RelayError("Cursor run cancelled", EXIT_CODES.cancelled, "CANCELLED");
    if (result.timedOut)
      throw new RelayError("Cursor run timed out", EXIT_CODES.provider, "PROVIDER_TIMEOUT");
    if (!request.config.policy.allow_payg && reportedApiSource && reportedApiSource !== "login") {
      throw new RelayError(
        `Cursor reported usage-based authentication source: ${reportedApiSource}`,
        EXIT_CODES.environment,
        "PAYG_AUTH_BLOCKED",
      );
    }
    if (result.exitCode !== 0) throw providerFailure(result.stderr);
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
      stdoutPath,
      stderrPath,
      events,
    };
  }
}

export function normalizeCursorEvent(line: string): NormalizedHarnessEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    raw = { text: line };
  }
  const record = isRecord(raw) ? raw : {};
  const externalType = typeof record.type === "string" ? record.type : "unknown";
  const subtype = typeof record.subtype === "string" ? record.subtype : "";
  const type =
    externalType === "system" && subtype === "init"
      ? "init"
      : externalType === "assistant"
        ? "message"
        : externalType === "tool_call"
          ? subtype === "completed"
            ? "tool_completed"
            : "tool_started"
          : externalType === "result"
            ? "result"
            : "unknown";
  return {
    type,
    timestamp: new Date().toISOString(),
    ...(typeof record.session_id === "string" ? { sessionId: record.session_id } : {}),
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

export function parseCursorModels(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.replace(/^[-*\s]+/, "").trim())
    .filter((line) => line && !/available models|select/i.test(line))
    .map((line) => line.split(/\s+-\s+/, 1)[0]?.trim() ?? "")
    .filter(Boolean);
}

function providerFailure(stderr: string): RelayError {
  if (/quota|rate.?limit|usage.?limit/i.test(stderr)) {
    return new RelayError(
      "Cursor quota or rate limit reached",
      EXIT_CODES.awaitingUser,
      "PROVIDER_QUOTA",
    );
  }
  if (/auth|login|unauthorized|forbidden/i.test(stderr)) {
    return new RelayError("Cursor is not authenticated", EXIT_CODES.environment, "PROVIDER_AUTH");
  }
  return new RelayError(
    `Cursor exited unsuccessfully: ${stderr.trim() || "no error text"}`,
    EXIT_CODES.provider,
    "PROVIDER_FAILED",
  );
}

function firstLine(value: string): string | undefined {
  return value.trim().split("\n")[0] || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
