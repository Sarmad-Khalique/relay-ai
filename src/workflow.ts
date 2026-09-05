import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ValidateFunction } from "ajv";
import { ulid } from "ulid";
import type {
  EventSink,
  HarnessAdapter,
  HarnessResumeRequest,
  HarnessRunRequest,
  HarnessRunResult,
  ProviderCapabilities,
} from "./adapter-contract.js";
import {
  metadataForExistingArtifact,
  sha256,
  writeJsonArtifact,
  writePrivateArtifact,
} from "./artifacts.js";
import {
  assertConfiguredModels,
  provenwayConfigSchema,
  resolveConfiguration,
  type ConfigOverrides,
  type ProvenWayConfig,
  type ResolvedConfig,
  type VerificationCommand,
} from "./config.js";
import { applyCursorOverlay, restoreCursorOverlay } from "./cursor-overlay.js";
import { EXIT_CODES, ProvenWayError, asProvenWayError } from "./errors.js";
import {
  commitWorktree,
  createManagedWorktree,
  gitChanges,
  inspectRepository,
  isRegisteredWorktree,
  removeManagedWorktree,
  verifyRepositoryUnchanged,
  worktreeDiff,
  type RepositoryInfo,
} from "./git.js";
import type { ProvenWayPaths } from "./paths.js";
import { assertNoForbiddenPaths } from "./policy.js";
import {
  implementationPrompt,
  jsonRepairPrompt,
  planningPrompt,
  repairPrompt,
  reviewPrompt,
} from "./prompts.js";
import { acquireRepositoryLock } from "./repo-lock.js";
import {
  parseJsonOutput,
  validateOrThrow,
  validators,
  type ImplementationResult,
  type ReviewResult,
  type RunManifest,
  type TaskPacket,
  type VerificationResult,
} from "./schemas.js";
import { canTransition, isTerminal, type RunStatus } from "./state-machine.js";
import { RunStore, type RunRecord } from "./store.js";
import type { ProvenWayUi } from "./ui.js";
import {
  describeNetworkEnforcement,
  discoverVerificationCommands,
  mergeVerificationCommands,
  runVerification,
} from "./verifier.js";

export interface WorkflowAdapters {
  codex: HarnessAdapter;
  cursor: HarnessAdapter;
}

export interface ExecuteOptions {
  cwd: string;
  task: string;
  planOnly?: boolean;
  overrides?: ConfigOverrides;
  signal?: AbortSignal;
}

export interface WorkflowOutcome {
  run: RunRecord;
  packet?: TaskPacket;
  verification?: VerificationResult;
  review?: ReviewResult;
}

export class WorkflowEngine {
  constructor(
    private readonly paths: ProvenWayPaths,
    private readonly store: RunStore,
    private readonly adapters: WorkflowAdapters,
    private readonly ui: ProvenWayUi,
  ) {}

  async execute(options: ExecuteOptions): Promise<WorkflowOutcome> {
    const repository = await inspectRepository(options.cwd);
    const resolved = await resolveConfiguration(this.paths, repository.root, options.overrides);
    assertConfiguredModels(resolved.config);
    if (resolved.config.workflow.require_clean_worktree && !repository.clean) {
      throw new ProvenWayError(
        `Source checkout is not clean:\n${repository.status}`,
        EXIT_CODES.invalidInput,
        "DIRTY_SOURCE_CHECKOUT",
      );
    }

    const runId = ulid();
    const runDirectory = path.join(this.paths.runsDir, runId);
    const lock = await acquireRepositoryLock(this.paths.locksDir, repository.root, runId);
    try {
      const otherActive = this.store.findActiveByRepository(repository.root);
      if (otherActive.length > 0) {
        throw new ProvenWayError(
          `Repository already has an unfinished run: ${otherActive[0]?.runId ?? "unknown"}`,
          EXIT_CODES.awaitingUser,
          "UNFINISHED_RUN_EXISTS",
        );
      }
      this.store.createRun({
        runId,
        task: options.task,
        repositoryRoot: repository.root,
        baseCommit: repository.baseCommit,
        configuration: resolved.config,
      });
      await this.transition(runId, "preparing", "probing providers");
      const capabilities = await this.probeRequiredProviders(
        repository,
        resolved.config,
        Boolean(options.planOnly),
      );
      this.store.setProviders(runId, capabilities);
      await this.syncManifest(runId);

      const run = await this.transition(runId, "planning", "starting read-only architecture stage");
      const packet = await this.plan(run, repository, resolved, runDirectory, options.signal);
      const packetArtifact = await writeJsonArtifact(
        runDirectory,
        "task-packet.json",
        packet,
        "planning",
      );
      this.store.addArtifact(runId, packetArtifact);
      await this.syncManifest(runId);

      const blockingQuestions = packet.open_questions.filter((question) => question.blocking);
      if (blockingQuestions.length > 0) {
        await this.transition(runId, "blocked_user", "TaskPacket contains blocking questions");
        this.ui.warn(blockingQuestions.map((question) => question.text).join("\n"));
        return { run: this.store.requireRun(runId), packet };
      }
      if (!packet.change_required) {
        await this.transition(runId, "accepted_no_change", "architect found no change required");
        return { run: this.store.requireRun(runId), packet };
      }
      if (options.planOnly) {
        await this.transition(runId, "planned", "plan-only command completed");
        return { run: this.store.requireRun(runId), packet };
      }

      const discovered = resolved.config.verification.discover
        ? await discoverVerificationCommands(repository.root)
        : [];
      const verificationCommands = mergeVerificationCommands(
        resolved.config.verification.commands,
        discovered,
      );
      const networkEnforcement = await describeNetworkEnforcement();
      await this.transition(runId, "awaiting_confirmation", "waiting for write confirmation");
      await this.confirmWrite(runId, resolved.config, verificationCommands, networkEnforcement);
      await verifyRepositoryUnchanged(
        repository.root,
        repository.baseCommit,
        resolved.config.workflow.require_clean_worktree,
      );

      await this.transition(runId, "creating_worktree", "creating isolated Git worktree");
      const location = await createManagedWorktree({
        repositoryRoot: repository.root,
        managedRoot: this.paths.worktreesDir,
        runId,
        task: options.task,
        baseCommit: repository.baseCommit,
      });
      this.store.setLocations(runId, location.branch, location.worktree);
      await this.syncManifest(runId);

      const implementation = await this.implement(
        runId,
        packet,
        repository,
        location.worktree,
        runDirectory,
        resolved.config,
        options.signal,
      );
      return await this.finishWorktree({
        runId,
        packet,
        repository,
        worktree: location.worktree,
        runDirectory,
        verificationCommands,
        config: resolved.config,
        ...(implementation.provider_session_id
          ? { sessionId: implementation.provider_session_id }
          : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      await this.recordFailure(runId, error);
      throw asProvenWayError(error);
    } finally {
      await lock.release();
    }
  }

  async resume(runId: string, signal?: AbortSignal): Promise<WorkflowOutcome> {
    let run = this.store.requireRun(runId);
    if (isTerminal(run.status) && run.status !== "implemented_unreviewed") {
      throw new ProvenWayError(
        `Run ${runId} is already terminal: ${run.status}`,
        EXIT_CODES.invalidInput,
        "RUN_ALREADY_TERMINAL",
      );
    }
    const parsedConfig = provenwayConfigSchema.safeParse(run.configuration);
    if (!parsedConfig.success) {
      throw new ProvenWayError(
        "Stored run configuration is invalid",
        EXIT_CODES.invalidInput,
        "INVALID_STORED_CONFIG",
      );
    }
    const config = parsedConfig.data;
    const repository = await inspectRepository(run.repositoryRoot);
    const lock = await acquireRepositoryLock(this.paths.locksDir, run.repositoryRoot, runId);
    const runDirectory = path.join(this.paths.runsDir, runId);
    try {
      if (
        ![
          "blocked_user",
          "blocked_auth",
          "blocked_quota",
          "awaiting_confirmation",
          "interrupted",
        ].includes(run.status)
      ) {
        run = this.store.forceInterrupted(runId, `resume reconciled stage ${run.status}`);
        await this.syncManifest(runId);
      }
      await this.probeRequiredProviders(repository, config, false);
      let packet = await readJsonArtifactOptional<TaskPacket>(runDirectory, "task-packet.json");
      if (packet) packet = validateOrThrow(validators.taskPacket, packet, "TaskPacket");
      if (!packet) {
        this.store.forceStatus(
          runId,
          "planning",
          "restarting interrupted read-only planning stage",
        );
        packet = await this.plan(
          this.store.requireRun(runId),
          repository,
          { config, provenance: {}, globalFile: this.paths.configFile },
          runDirectory,
          signal,
        );
        const packetArtifact = await writeJsonArtifact(
          runDirectory,
          "task-packet.json",
          packet,
          "planning",
        );
        this.store.addArtifact(runId, packetArtifact);
      }

      if (run.worktree) {
        if (!(await isRegisteredWorktree(run.repositoryRoot, run.worktree))) {
          throw new ProvenWayError(
            "Stored worktree is no longer registered; ProvenWay will not repeat the writer",
            EXIT_CODES.awaitingUser,
            "WORKTREE_MISSING",
          );
        }
        await restoreCursorOverlay(run.worktree, runDirectory);
        const changes = await gitChanges(run.worktree);
        if (changes.all.length === 0) {
          throw new ProvenWayError(
            "Interrupted writer left no diff; start a new run because ProvenWay will not repeat it silently",
            EXIT_CODES.awaitingUser,
            "WRITER_REPLAY_REFUSED",
          );
        }
        assertNoForbiddenPaths(changes.all, packet.forbidden_paths);
        const discovered = config.verification.discover
          ? await discoverVerificationCommands(run.repositoryRoot)
          : [];
        const commands = mergeVerificationCommands(config.verification.commands, discovered);
        const implementation = await readJsonArtifactOptional<ImplementationResult>(
          runDirectory,
          "implementation-result.json",
        );
        return await this.finishWorktree({
          runId,
          packet,
          repository,
          worktree: run.worktree,
          runDirectory,
          verificationCommands: commands,
          config,
          ...(implementation?.provider_session_id
            ? { sessionId: implementation.provider_session_id }
            : {}),
          ...(signal ? { signal } : {}),
        });
      }

      if (packet.open_questions.some((question) => question.blocking)) {
        if (!this.ui.interactive) {
          throw new ProvenWayError(
            "Answering blocking plan questions requires an interactive terminal",
            EXIT_CODES.awaitingUser,
            "TTY_REQUIRED",
          );
        }
        const answers: Record<string, string> = {};
        for (const question of packet.open_questions.filter((candidate) => candidate.blocking)) {
          answers[question.id] = await this.ui.input(question.text);
        }
        const decisions = await writeJsonArtifact(
          runDirectory,
          "user-decisions.json",
          { schema_version: "1.0", run_id: runId, answers },
          "planning",
        );
        this.store.addArtifact(runId, decisions);
        this.store.forceStatus(runId, "planning", "revising plan with user decisions");
        packet = await this.codexStructured(
          runId,
          "plan-revision",
          `Revise this TaskPacket using the user's answers. Return only valid TaskPacket JSON.\n\nTaskPacket:\n${JSON.stringify(packet, null, 2)}\n\nAnswers:\n${JSON.stringify(answers, null, 2)}`,
          validators.taskPacket,
          "TaskPacket",
          schemaPath("task-packet.schema.json"),
          repository.root,
          runDirectory,
          config.roles.architect.model,
          config.roles.architect.reasoning,
          config,
          signal,
        );
        if (packet.task_id !== runId || packet.repo_facts.base_commit !== run.baseCommit) {
          throw new ProvenWayError(
            "Revised TaskPacket does not match the active run",
            EXIT_CODES.provider,
            "TASK_PACKET_CONTEXT_MISMATCH",
          );
        }
        const packetArtifact = await writeJsonArtifact(
          runDirectory,
          "task-packet.json",
          packet,
          "planning",
        );
        this.store.addArtifact(runId, packetArtifact);
      }

      if (packet.open_questions.some((question) => question.blocking)) {
        this.store.forceStatus(runId, "blocked_user", "revised plan still has blocking questions");
        await this.syncManifest(runId);
        return { run: this.store.requireRun(runId), packet };
      }
      if (!packet.change_required) {
        this.store.forceStatus(runId, "accepted_no_change", "revised plan requires no changes");
        await this.syncManifest(runId);
        return { run: this.store.requireRun(runId), packet };
      }

      const discovered = config.verification.discover
        ? await discoverVerificationCommands(run.repositoryRoot)
        : [];
      const commands = mergeVerificationCommands(config.verification.commands, discovered);
      if (this.store.requireRun(runId).status !== "awaiting_confirmation") {
        this.store.forceStatus(
          runId,
          "awaiting_confirmation",
          "resumed before writer confirmation",
        );
      }
      await this.syncManifest(runId);
      await this.confirmWrite(runId, config, commands, await describeNetworkEnforcement());
      await verifyRepositoryUnchanged(
        run.repositoryRoot,
        run.baseCommit,
        config.workflow.require_clean_worktree,
      );
      await this.transition(
        runId,
        "creating_worktree",
        "creating isolated Git worktree after resume",
      );
      const location = await createManagedWorktree({
        repositoryRoot: run.repositoryRoot,
        managedRoot: this.paths.worktreesDir,
        runId,
        task: run.task,
        baseCommit: run.baseCommit,
      });
      this.store.setLocations(runId, location.branch, location.worktree);
      const implementation = await this.implement(
        runId,
        packet,
        repository,
        location.worktree,
        runDirectory,
        config,
        signal,
      );
      return await this.finishWorktree({
        runId,
        packet,
        repository,
        worktree: location.worktree,
        runDirectory,
        verificationCommands: commands,
        config,
        ...(implementation.provider_session_id
          ? { sessionId: implementation.provider_session_id }
          : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      await this.recordFailure(runId, error);
      throw asProvenWayError(error);
    } finally {
      await lock.release();
    }
  }

  private async finishWorktree(input: {
    runId: string;
    packet: TaskPacket;
    repository: RepositoryInfo;
    worktree: string;
    runDirectory: string;
    verificationCommands: VerificationCommand[];
    config: ProvenWayConfig;
    sessionId?: string;
    signal?: AbortSignal;
  }): Promise<WorkflowOutcome> {
    let verification = await this.verify(
      input.runId,
      input.worktree,
      input.runDirectory,
      input.verificationCommands,
      input.config,
      input.signal,
    );
    let review = await this.review(
      input.runId,
      input.packet,
      verification,
      input.worktree,
      input.runDirectory,
      input.config,
      input.signal,
    );

    let repairCount = this.store.requireRun(input.runId).repairCount;
    while (!verification.passed || hasBlockers(review)) {
      if (repairCount >= input.config.workflow.repair_attempts) {
        await this.transition(
          input.runId,
          verification.passed ? "changes_requested" : "failed_verification",
          "repair limit exhausted",
        );
        return {
          run: this.store.requireRun(input.runId),
          packet: input.packet,
          verification,
          review,
        };
      }
      repairCount += 1;
      this.store.setRepairCount(input.runId, repairCount);
      review = withVerificationBlocker(review, verification);
      await this.repair(
        input.runId,
        input.packet,
        review,
        verification,
        input.sessionId,
        input.worktree,
        input.runDirectory,
        input.config,
        input.signal,
      );
      verification = await this.verify(
        input.runId,
        input.worktree,
        input.runDirectory,
        input.verificationCommands,
        input.config,
        input.signal,
      );
      review = await this.review(
        input.runId,
        input.packet,
        verification,
        input.worktree,
        input.runDirectory,
        input.config,
        input.signal,
      );
    }

    await this.transition(
      input.runId,
      "finalizing",
      "committing accepted diff to ProvenWay branch",
    );
    const finalCommit = await commitWorktree(
      input.worktree,
      `provenway: ${slugForCommit(this.store.requireRun(input.runId).task)}`,
    );
    this.store.setFinalCommit(input.runId, finalCommit);
    await this.updateImplementationFinalCommit(input.runId, input.runDirectory, finalCommit);
    if (input.config.workflow.keep_worktree !== "always") {
      await removeManagedWorktree(input.repository.root, input.worktree);
    }
    await this.transition(input.runId, "accepted", "verification and review passed");
    return { run: this.store.requireRun(input.runId), packet: input.packet, verification, review };
  }

  private async probeRequiredProviders(
    repository: RepositoryInfo,
    config: ProvenWayConfig,
    planOnly: boolean,
  ): Promise<Record<string, ProviderCapabilities>> {
    const codex = await this.adapters.codex.probe({
      cwd: repository.root,
      executable: config.providers.codex.executable,
      deep: true,
    });
    assertProviderCapabilities("Codex", codex, "read-only", config.roles.architect.model, config);
    if (planOnly) return { codex };
    const cursor = await this.adapters.cursor.probe({
      cwd: repository.root,
      executable: config.providers.cursor.executable,
      deep: true,
    });
    assertProviderCapabilities(
      "Cursor",
      cursor,
      "workspace-write",
      config.roles.implementer.model,
      config,
    );
    return { codex, cursor };
  }

  private async plan(
    run: RunRecord,
    repository: RepositoryInfo,
    resolved: ResolvedConfig,
    runDirectory: string,
    signal?: AbortSignal,
  ): Promise<TaskPacket> {
    const prompt = planningPrompt({
      task: run.task,
      taskId: run.runId,
      repository,
      forbiddenPaths: resolved.config.policy.forbidden_paths,
    });
    const packet = await this.codexStructured(
      run.runId,
      "plan",
      prompt,
      validators.taskPacket,
      "TaskPacket",
      schemaPath("task-packet.schema.json"),
      repository.root,
      runDirectory,
      resolved.config.roles.architect.model,
      resolved.config.roles.architect.reasoning,
      resolved.config,
      signal,
    );
    if (packet.task_id !== run.runId || packet.repo_facts.base_commit !== repository.baseCommit) {
      throw new ProvenWayError(
        "TaskPacket does not match the active run ID and base commit",
        EXIT_CODES.provider,
        "TASK_PACKET_CONTEXT_MISMATCH",
      );
    }
    packet.forbidden_paths = [
      ...new Set([...resolved.config.policy.forbidden_paths, ...packet.forbidden_paths]),
    ];
    return packet;
  }

  private async implement(
    runId: string,
    packet: TaskPacket,
    repository: RepositoryInfo,
    worktree: string,
    runDirectory: string,
    config: ProvenWayConfig,
    signal?: AbortSignal,
  ): Promise<ImplementationResult> {
    await this.transition(runId, "implementing", "starting Cursor implementation");
    let result: HarnessRunResult;
    try {
      await applyCursorOverlay(worktree, runDirectory, packet.forbidden_paths);
      result = await this.invokeAdapter(
        this.adapters.cursor,
        requestFor({
          runId,
          stage: "cursor-implement",
          cwd: worktree,
          model: config.roles.implementer.model,
          permissionMode: "workspace-write",
          prompt: implementationPrompt(packet),
          runDirectory,
          config,
          ...(signal ? { signal } : {}),
        }),
      );
    } finally {
      await restoreCursorOverlay(worktree, runDirectory);
    }

    const changes = await gitChanges(worktree);
    assertNoForbiddenPaths(changes.all, packet.forbidden_paths);
    const diff = await worktreeDiff(worktree);
    if (!diff.trim()) {
      throw new ProvenWayError(
        "Cursor completed without producing a diff",
        EXIT_CODES.provider,
        "EMPTY_IMPLEMENTATION",
      );
    }
    const diffArtifact = await writePrivateArtifact(
      runDirectory,
      "diff.patch",
      diff,
      "text/x-diff",
      "implementing",
    );
    this.store.addArtifact(runId, diffArtifact);

    const claims = parseImplementationClaims(result.finalText);
    const implementation: ImplementationResult = {
      schema_version: "1.0",
      task_id: runId,
      base_commit: repository.baseCommit,
      final_commit: null,
      provider_session_id: result.sessionId ?? null,
      process: {
        exit_code: result.exitCode,
        signal: result.signal,
        started_at: result.startedAt,
        finished_at: result.finishedAt,
        duration_ms: result.durationMs,
      },
      claimed_commands: claims.commands,
      claimed_paths: claims.paths,
      acceptance_criteria_addressed: claims.acceptanceCriteria,
      deviations: claims.deviations,
      unresolved_items: claims.unresolved,
      provenway_git: {
        diff_sha256: sha256(diff),
        changed: changes.changed,
        created: changes.created,
        deleted: changes.deleted,
      },
    };
    validateOrThrow(validators.implementationResult, implementation, "ImplementationResult");
    const artifact = await writeJsonArtifact(
      runDirectory,
      "implementation-result.json",
      implementation,
      "implementing",
    );
    this.store.addArtifact(runId, artifact);
    await this.syncManifest(runId);
    return implementation;
  }

  private async verify(
    runId: string,
    worktree: string,
    runDirectory: string,
    commands: VerificationCommand[],
    config: ProvenWayConfig,
    signal?: AbortSignal,
  ): Promise<VerificationResult> {
    await this.transition(runId, "verifying", "running deterministic verification");
    this.store.addStage({ runId, name: "verify", status: "starting" });
    const verification = await runVerification({
      taskId: runId,
      worktree,
      logDirectory: path.join(runDirectory, "verification"),
      commands,
      ...(signal ? { signal } : {}),
      maxLogBytes: config.workflow.max_log_bytes,
      onOutput: (command, stream, line) => {
        if (line.trim()) this.ui.info(`[${command}:${stream}] ${line}`);
      },
    });
    validateOrThrow(validators.verificationResult, verification, "VerificationResult");
    this.store.addStage({
      runId,
      name: "verify",
      status: verification.passed ? "completed" : "failed",
      detail: { passed: verification.passed },
    });
    const artifact = await writeJsonArtifact(
      runDirectory,
      "verification-result.json",
      verification,
      "verifying",
    );
    this.store.addArtifact(runId, artifact);
    const changes = await gitChanges(worktree);
    assertNoForbiddenPaths(changes.all, config.policy.forbidden_paths);
    await this.refreshDiff(runId, worktree, runDirectory, "verifying");
    await this.syncManifest(runId);
    return verification;
  }

  private async review(
    runId: string,
    packet: TaskPacket,
    verification: VerificationResult,
    worktree: string,
    runDirectory: string,
    config: ProvenWayConfig,
    signal?: AbortSignal,
  ): Promise<ReviewResult> {
    await this.transition(runId, "reviewing", "starting read-only Codex review");
    try {
      const review = await this.codexStructured(
        runId,
        `review-${this.store.requireRun(runId).repairCount}`,
        reviewPrompt(packet, verification),
        validators.reviewResult,
        "ReviewResult",
        schemaPath("review-result.schema.json"),
        worktree,
        runDirectory,
        config.roles.reviewer.model,
        config.roles.reviewer.reasoning,
        config,
        signal,
      );
      if (review.task_id !== runId) {
        throw new ProvenWayError(
          "ReviewResult task_id does not match the active run",
          EXIT_CODES.provider,
          "REVIEW_CONTEXT_MISMATCH",
        );
      }
      const combined = withVerificationBlocker(review, verification);
      const artifact = await writeJsonArtifact(
        runDirectory,
        "review-result.json",
        combined,
        "reviewing",
      );
      this.store.addArtifact(runId, artifact);
      await this.syncManifest(runId);
      return combined;
    } catch (error) {
      if (
        error instanceof ProvenWayError &&
        ["PROVIDER_AUTH", "PROVIDER_QUOTA"].includes(error.code)
      ) {
        throw error;
      }
      await this.transition(runId, "implemented_unreviewed", "review provider unavailable");
      throw error;
    }
  }

  private async repair(
    runId: string,
    packet: TaskPacket,
    review: ReviewResult,
    verification: VerificationResult,
    sessionId: string | undefined,
    worktree: string,
    runDirectory: string,
    config: ProvenWayConfig,
    signal?: AbortSignal,
  ): Promise<void> {
    const attempt = this.store.requireRun(runId).repairCount;
    await this.transition(runId, "repairing", `starting repair attempt ${attempt}`);
    try {
      await applyCursorOverlay(worktree, runDirectory, packet.forbidden_paths);
      const request = requestFor({
        runId,
        stage: `cursor-repair-${attempt}`,
        cwd: worktree,
        model: config.roles.implementer.model,
        permissionMode: "workspace-write",
        prompt: repairPrompt(packet, review, verification),
        runDirectory,
        config,
        ...(signal ? { signal } : {}),
      });
      if (sessionId && this.adapters.cursor.resume) {
        await this.invokeAdapter(this.adapters.cursor, { ...request, sessionId });
      } else {
        await this.invokeAdapter(this.adapters.cursor, request);
      }
    } finally {
      await restoreCursorOverlay(worktree, runDirectory);
    }
    const changes = await gitChanges(worktree);
    assertNoForbiddenPaths(changes.all, packet.forbidden_paths);
    await this.refreshDiff(runId, worktree, runDirectory, "repairing");
  }

  private async codexStructured<T>(
    runId: string,
    stage: string,
    prompt: string,
    validator: ValidateFunction<T>,
    label: string,
    outputSchemaPath: string,
    cwd: string,
    runDirectory: string,
    model: string,
    reasoning: "low" | "medium" | "high" | undefined,
    config: ProvenWayConfig,
    signal?: AbortSignal,
  ): Promise<T> {
    const outputFile = path.join(runDirectory, `${stage}.final.json`);
    const request = requestFor({
      runId,
      stage: `codex-${stage}`,
      cwd,
      model,
      ...(reasoning ? { reasoning } : {}),
      permissionMode: "read-only",
      prompt,
      schemaPath: outputSchemaPath,
      outputFile,
      runDirectory,
      config,
      ...(signal ? { signal } : {}),
    });
    const first = await this.invokeAdapter(this.adapters.codex, request);
    try {
      return parseJsonOutput(validator, first.finalText, label);
    } catch (firstError) {
      const invalidArtifact = await writePrivateArtifact(
        runDirectory,
        `${stage}.invalid.txt`,
        first.finalText,
        "text/plain",
        stage,
      );
      this.store.addArtifact(runId, invalidArtifact);
      const repaired = await this.invokeAdapter(
        this.adapters.codex,
        requestFor({
          runId,
          stage: `codex-${stage}-json-repair`,
          cwd,
          model,
          ...(reasoning ? { reasoning } : {}),
          permissionMode: "read-only",
          prompt: jsonRepairPrompt(label, first.finalText),
          schemaPath: outputSchemaPath,
          outputFile: path.join(runDirectory, `${stage}.repaired.final.json`),
          runDirectory,
          config,
          ...(signal ? { signal } : {}),
        }),
      );
      try {
        return parseJsonOutput(validator, repaired.finalText, label);
      } catch {
        throw firstError;
      }
    }
  }

  private async invokeAdapter(
    adapter: HarnessAdapter,
    request: HarnessRunRequest | HarnessResumeRequest,
  ): Promise<HarnessRunResult> {
    this.store.addStage({ runId: request.runId, name: request.stage, status: "starting" });
    const sink: EventSink = {
      emit: (event) => {
        if (event.type === "message") this.ui.info(`${adapter.id}: working`);
      },
    };
    try {
      const result =
        "sessionId" in request && adapter.resume
          ? await adapter.resume(request, sink)
          : await adapter.start(request, sink);
      this.store.addInvocation({
        runId: request.runId,
        stage: request.stage,
        adapter: adapter.id,
        executable: result.executable,
        args: result.args.map((argument) =>
          argument.length > 240 ? `<content sha256:${sha256(argument)}>` : argument,
        ),
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        exitCode: result.exitCode,
        signal: result.signal,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      });
      const eventArtifact = await writePrivateArtifact(
        request.logDirectory,
        `${request.stage}.events.ndjson`,
        result.events.map((event) => JSON.stringify(event)).join("\n") + "\n",
        "application/x-ndjson",
        request.stage,
      );
      this.store.addArtifact(request.runId, eventArtifact);
      for (const [file, suffix, mediaType] of [
        [result.stdoutPath, "stdout.ndjson", "application/x-ndjson"],
        [result.stderrPath, "stderr.log", "text/plain"],
      ] as const) {
        const artifact = await metadataForExistingArtifact(
          file,
          `${request.stage}.${suffix}`,
          mediaType,
          request.stage,
        );
        this.store.addArtifact(request.runId, artifact);
      }
      const finalArtifact = await writePrivateArtifact(
        request.logDirectory,
        `${request.stage}.final.txt`,
        result.finalText,
        "text/plain",
        request.stage,
      );
      this.store.addArtifact(request.runId, finalArtifact);
      this.store.addStage({ runId: request.runId, name: request.stage, status: "completed" });
      await this.syncManifest(request.runId);
      return result;
    } catch (error) {
      this.store.addStage({
        runId: request.runId,
        name: request.stage,
        status: "failed",
        detail: { error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  private async confirmWrite(
    runId: string,
    config: ProvenWayConfig,
    commands: VerificationCommand[],
    networkEnforcement: string,
  ): Promise<void> {
    if (!this.ui.interactive) {
      throw new ProvenWayError(
        "Write-capable runs require an interactive terminal; the run can be resumed in a TTY",
        EXIT_CODES.awaitingUser,
        "TTY_REQUIRED",
      );
    }
    const proposedBranch = `provenway/${runId.slice(0, 8).toLowerCase()}-*`;
    this.ui.info(`Branch: ${proposedBranch}`);
    this.ui.info(
      `Models: architect=${config.roles.architect.model}, implementer=${config.roles.implementer.model}, reviewer=${config.roles.reviewer.model}`,
    );
    this.ui.info(
      `Verification: ${commands.length ? commands.map((item) => item.argv.join(" ")).join("; ") : "no commands configured or discovered"}`,
    );
    this.ui.info(
      `Network: denied${networkEnforcement === "unavailable" ? " (host enforcement unavailable)" : ` via ${networkEnforcement}`}`,
    );
    const confirmed = await this.ui.confirm(
      "Allow Cursor to write in the isolated worktree?",
      false,
    );
    if (!confirmed) {
      await this.transition(runId, "cancelled", "user declined write confirmation");
      throw new ProvenWayError("Run cancelled", EXIT_CODES.cancelled, "CANCELLED");
    }
  }

  private async refreshDiff(
    runId: string,
    worktree: string,
    runDirectory: string,
    stage: string,
  ): Promise<void> {
    const diff = await worktreeDiff(worktree);
    const artifact = await writePrivateArtifact(
      runDirectory,
      "diff.patch",
      diff,
      "text/x-diff",
      stage,
    );
    this.store.addArtifact(runId, artifact);
  }

  private async updateImplementationFinalCommit(
    runId: string,
    runDirectory: string,
    finalCommit: string,
  ): Promise<void> {
    const implementation = await readJsonArtifactOptional<ImplementationResult>(
      runDirectory,
      "implementation-result.json",
    );
    if (!implementation) return;
    implementation.final_commit = finalCommit;
    validateOrThrow(validators.implementationResult, implementation, "ImplementationResult");
    const artifact = await writeJsonArtifact(
      runDirectory,
      "implementation-result.json",
      implementation,
      "finalizing",
    );
    this.store.addArtifact(runId, artifact);
  }

  private async transition(runId: string, status: RunStatus, detail: string): Promise<RunRecord> {
    const run = this.store.transition(runId, status, detail);
    await this.syncManifest(runId);
    return run;
  }

  private async syncManifest(runId: string): Promise<void> {
    const run = this.store.requireRun(runId);
    const manifest: RunManifest = {
      schema_version: "1.0",
      run_id: run.runId,
      task: run.task,
      status: run.status,
      repository_root: run.repositoryRoot,
      base_commit: run.baseCommit,
      final_commit: run.finalCommit,
      ...(run.branch ? { branch: run.branch } : {}),
      ...(run.worktree ? { worktree: run.worktree } : {}),
      created_at: run.createdAt,
      updated_at: run.updatedAt,
      repair_count: run.repairCount,
      configuration: asObject(run.configuration),
      providers: asObject(run.providers),
      transitions: this.store.transitions(runId).map((transition) => ({
        from: transition.from,
        to: transition.to,
        at: transition.at,
        ...(transition.detail ? { detail: transition.detail } : {}),
      })),
      artifacts: this.store
        .artifacts(runId)
        .filter((artifact) => artifact.name !== "run-manifest.json"),
    };
    validateOrThrow(validators.runManifest, manifest, "RunManifest");
    const artifact = await writeJsonArtifact(
      path.join(this.paths.runsDir, runId),
      "run-manifest.json",
      manifest,
      run.status,
    );
    this.store.addArtifact(runId, artifact);
  }

  private async recordFailure(runId: string, error: unknown): Promise<void> {
    const current = this.store.getRun(runId);
    if (!current || isTerminal(current.status)) return;
    const provenwayError = asProvenWayError(error);
    const target = failureStatus(current.status, provenwayError);
    if (canTransition(current.status, target))
      this.store.transition(runId, target, provenwayError.message);
    else this.store.forceStatus(runId, target, provenwayError.message);
    try {
      await this.syncManifest(runId);
    } catch {
      // The database transition is the durable fallback if manifest writing fails.
    }
  }
}

function requestFor(input: {
  runId: string;
  stage: string;
  cwd: string;
  model: string;
  reasoning?: "low" | "medium" | "high";
  permissionMode: "read-only" | "workspace-write";
  prompt: string;
  schemaPath?: string;
  outputFile?: string;
  runDirectory: string;
  config: ProvenWayConfig;
  signal?: AbortSignal;
}): HarnessRunRequest {
  return {
    runId: input.runId,
    stage: input.stage,
    cwd: input.cwd,
    model: input.model,
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    permissionMode: input.permissionMode,
    prompt: input.prompt,
    ...(input.schemaPath ? { schemaPath: input.schemaPath } : {}),
    ...(input.outputFile ? { outputFile: input.outputFile } : {}),
    logDirectory: path.join(input.runDirectory, "providers"),
    timeoutMs: input.config.workflow.provider_timeout_seconds * 1_000,
    maxEventBytes: input.config.workflow.max_event_bytes,
    maxLogBytes: input.config.workflow.max_log_bytes,
    config: input.config,
    ...(input.signal ? { signal: input.signal } : {}),
  };
}

function assertProviderCapabilities(
  name: string,
  capabilities: ProviderCapabilities,
  permission: "read-only" | "workspace-write",
  model: string,
  config: ProvenWayConfig,
): void {
  if (!capabilities.installed) {
    throw new ProvenWayError(
      `${name} CLI is not installed: ${capabilities.warnings.join("; ")}`,
      EXIT_CODES.environment,
      "PROVIDER_NOT_INSTALLED",
    );
  }
  if (capabilities.authenticated !== true) {
    throw new ProvenWayError(
      `${name} CLI is not authenticated`,
      EXIT_CODES.environment,
      "PROVIDER_AUTH",
    );
  }
  if (!config.policy.allow_payg && capabilities.authMode === "api-key") {
    throw new ProvenWayError(
      `${name} is authenticated with an API key while pay-as-you-go is disabled`,
      EXIT_CODES.environment,
      "PAYG_AUTH_BLOCKED",
    );
  }
  if (!capabilities.permissionModes.includes(permission)) {
    throw new ProvenWayError(
      `${name} cannot enforce required permission mode: ${permission}`,
      EXIT_CODES.environment,
      "PROVIDER_CAPABILITY_MISSING",
    );
  }
  if (
    name === "Codex" &&
    (!capabilities.supportsJsonEvents || !capabilities.supportsOutputSchema)
  ) {
    throw new ProvenWayError(
      "Codex is missing structured automation capabilities",
      EXIT_CODES.environment,
      "PROVIDER_CAPABILITY_MISSING",
    );
  }
  if (name === "Cursor" && !capabilities.supportsJsonEvents) {
    throw new ProvenWayError(
      "Cursor is missing stream-json support",
      EXIT_CODES.environment,
      "PROVIDER_CAPABILITY_MISSING",
    );
  }
  if (capabilities.warnings.length > 0) {
    throw new ProvenWayError(
      `${name} capability probe failed: ${capabilities.warnings.join("; ")}`,
      EXIT_CODES.environment,
      "PROVIDER_CAPABILITY_MISSING",
    );
  }
  if (capabilities.availableModels?.length && !capabilities.availableModels.includes(model)) {
    throw new ProvenWayError(
      `${name} model is not available: ${model}`,
      EXIT_CODES.environment,
      "MODEL_UNAVAILABLE",
    );
  }
}

function withVerificationBlocker(
  review: ReviewResult,
  verification: VerificationResult,
): ReviewResult {
  if (verification.passed || review.findings.some((finding) => finding.id === "PROVENWAY-VERIFY")) {
    return review;
  }
  const failed = verification.commands
    .filter((command) => command.required && command.exit_code !== 0)
    .map((command) => command.name)
    .join(", ");
  return {
    ...review,
    verdict: "changes_requested",
    findings: [
      ...review.findings,
      {
        id: "PROVENWAY-VERIFY",
        severity: "blocking",
        path: null,
        line: null,
        title: "Required verification failed",
        evidence: failed || "A required verification command did not complete successfully.",
        required_change: "Fix the implementation so every required verification command passes.",
      },
    ],
  };
}

function hasBlockers(review: ReviewResult): boolean {
  return review.findings.some((finding) => finding.severity === "blocking");
}

function parseImplementationClaims(finalText: string): {
  commands: string[];
  paths: { changed: string[]; created: string[]; deleted: string[] };
  acceptanceCriteria: string[];
  deviations: string[];
  unresolved: string[];
} {
  const empty = {
    commands: [] as string[],
    paths: { changed: [] as string[], created: [] as string[], deleted: [] as string[] },
    acceptanceCriteria: [] as string[],
    deviations: [] as string[],
    unresolved: [] as string[],
  };
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(finalText)?.[1];
  try {
    const value: unknown = JSON.parse(fenced ?? finalText);
    if (!isRecord(value)) return empty;
    return {
      commands: stringArray(value.commands),
      paths: isRecord(value.paths)
        ? {
            changed: stringArray(value.paths.changed),
            created: stringArray(value.paths.created),
            deleted: stringArray(value.paths.deleted),
          }
        : empty.paths,
      acceptanceCriteria: stringArray(value.acceptance_criteria_addressed),
      deviations: stringArray(value.deviations),
      unresolved: stringArray(value.unresolved_items),
    };
  } catch {
    return empty;
  }
}

function failureStatus(current: RunStatus, error: ProvenWayError): RunStatus {
  if (error.code === "CANCELLED" || error.exitCode === EXIT_CODES.cancelled) return "cancelled";
  if (error.code === "PROVIDER_QUOTA") return "blocked_quota";
  if (["PROVIDER_AUTH", "PAYG_AUTH_BLOCKED"].includes(error.code)) return "blocked_auth";
  if (
    [
      "TTY_REQUIRED",
      "BASE_COMMIT_CHANGED",
      "SOURCE_CHECKOUT_CHANGED",
      "WORKTREE_MISSING",
      "WRITER_REPLAY_REFUSED",
      "UNFINISHED_RUN_EXISTS",
      "REPOSITORY_LOCKED",
    ].includes(error.code)
  ) {
    return "blocked_user";
  }
  if (error.code.includes("FORBIDDEN") || error.code.includes("PATH_ESCAPE"))
    return "failed_policy";
  if (current === "reviewing") return "implemented_unreviewed";
  if (error.exitCode === EXIT_CODES.invalidInput) return "failed_config";
  if (error.exitCode === EXIT_CODES.verification) return "failed_verification";
  return "failed_provider";
}

function schemaPath(name: string): string {
  return fileURLToPath(new URL(`../schemas/${name}`, import.meta.url));
}

function slugForCommit(task: string): string {
  return task.replace(/\s+/g, " ").trim().slice(0, 68) || "apply planned changes";
}

function asObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

async function readJsonArtifactOptional<T>(
  runDirectory: string,
  name: string,
): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path.join(runDirectory, name), "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
