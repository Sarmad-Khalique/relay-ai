import type { ProvenWayConfig } from "./config.js";

export type AdapterId = string;
export type PermissionMode = "read-only" | "workspace-write";

export interface ProbeContext {
  cwd: string;
  executable?: string;
  deep?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface ProviderCapabilities {
  installed: boolean;
  executable?: string;
  version?: string;
  authenticated: boolean | "unknown";
  authMode?: "account" | "api-key" | "unknown";
  models: "discoverable" | "configured-only";
  availableModels?: string[];
  supportsJsonEvents: boolean;
  supportsOutputSchema: boolean;
  supportsResume: boolean;
  permissionModes: PermissionMode[];
  warnings: string[];
}

export interface NormalizedHarnessEvent {
  type: "init" | "message" | "tool_started" | "tool_completed" | "result" | "unknown";
  timestamp: string;
  sessionId?: string;
  payload: unknown;
  raw: unknown;
}

export interface EventSink {
  emit(event: NormalizedHarnessEvent): void | Promise<void>;
}

export interface HarnessRunRequest {
  runId: string;
  stage: string;
  cwd: string;
  model: string;
  reasoning?: "low" | "medium" | "high";
  permissionMode: PermissionMode;
  prompt: string;
  schemaPath?: string;
  outputFile?: string;
  logDirectory: string;
  timeoutMs: number;
  maxEventBytes: number;
  maxLogBytes: number;
  config: ProvenWayConfig;
  signal?: AbortSignal;
}

export interface HarnessResumeRequest extends HarnessRunRequest {
  sessionId: string;
}

export interface HarnessRunResult {
  adapterId: string;
  executable: string;
  args: string[];
  sessionId?: string;
  finalText: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
  events: NormalizedHarnessEvent[];
  authMode?: "account" | "api-key" | "unknown";
}

export interface HarnessAdapter {
  readonly id: AdapterId;
  probe(ctx: ProbeContext): Promise<ProviderCapabilities>;
  start(req: HarnessRunRequest, sink: EventSink): Promise<HarnessRunResult>;
  resume?(req: HarnessResumeRequest, sink: EventSink): Promise<HarnessRunResult>;
  cancel(runId: string): Promise<void>;
}
