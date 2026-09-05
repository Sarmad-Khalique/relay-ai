import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Command, Option } from "commander";
import packageJson from "../package.json" with { type: "json" };
import { CodexAdapter } from "./adapters/codex.js";
import { CursorAdapter } from "./adapters/cursor.js";
import { resolveConfiguration, type ConfigOverrides } from "./config.js";
import { runDoctor } from "./doctor.js";
import { EXIT_CODES, ProvenWayError, asProvenWayError } from "./errors.js";
import { deleteBranch, isRegisteredWorktree, removeManagedWorktree } from "./git.js";
import { ensureProvenWayPaths, isPathInside, resolveProvenWayPaths } from "./paths.js";
import { cancelLockedRun } from "./repo-lock.js";
import { initializeConfiguration } from "./setup.js";
import { isTerminal, type RunStatus } from "./state-machine.js";
import { RunStore, type RunRecord } from "./store.js";
import { ConsoleUi, type ProvenWayUi } from "./ui.js";
import { WorkflowEngine, type WorkflowOutcome } from "./workflow.js";

interface RunCommandOptions {
  architectModel?: string;
  implementerModel?: string;
  reviewerModel?: string;
  repairAttempts?: number;
  keepWorktree?: "always" | "on_failure" | "never";
}

export function buildProgram(ui: ProvenWayUi = new ConsoleUi()): Command {
  const program = new Command()
    .name("provenway")
    .description("Deterministic local orchestration for authenticated AI coding CLIs")
    .version(packageJson.version)
    .showHelpAfterError();

  program
    .command("init")
    .description("Create or update ProvenWay's global configuration")
    .action(async () => {
      const paths = resolveProvenWayPaths();
      await ensureProvenWayPaths(paths);
      await initializeConfiguration(paths, ui, process.cwd());
    });

  program
    .command("doctor")
    .description("Check providers, authentication, models, Git, and local storage")
    .option("--deep", "also discover models and inspect optional capabilities")
    .action(async (options: { deep?: boolean }) => {
      const paths = resolveProvenWayPaths();
      const result = await runDoctor(paths, ui, process.cwd(), Boolean(options.deep));
      if (!result.healthy) process.exitCode = EXIT_CODES.environment;
    });

  addWorkflowOptions(
    program
      .command("run")
      .description("Execute the plan, implement, verify, review, and repair workflow")
      .argument("<task>", "software task to complete"),
  ).action(async (task: string, options: RunCommandOptions) => {
    await executeWorkflow(ui, task, options, false);
  });

  addWorkflowOptions(
    program
      .command("plan")
      .description("Produce a validated TaskPacket without changing files")
      .argument("<task>", "software task to plan"),
  ).action(async (task: string, options: RunCommandOptions) => {
    await executeWorkflow(ui, task, options, true);
  });

  program
    .command("status")
    .description("Show a run or recent run history")
    .argument("[run]", "run ID")
    .action(async (runId?: string) => {
      await withStore((store) => {
        if (runId) renderRun(ui, store.requireRun(runId));
        else {
          const runs = store.listRuns();
          if (!runs.length) ui.info("No ProvenWay runs found.");
          for (const run of runs) renderRun(ui, run);
        }
      });
    });

  program
    .command("logs")
    .description("Show persisted redacted logs for a run")
    .argument("<run>", "run ID")
    .option("--stage <stage>", "only show artifacts from a stage")
    .action(async (runId: string, options: { stage?: string }) => {
      await withStore(async (store) => {
        store.requireRun(runId);
        const artifacts = store
          .artifacts(runId)
          .filter((artifact) =>
            options.stage
              ? artifact.stage.includes(options.stage)
              : /(?:stdout|stderr|events)/.test(artifact.name),
          );
        if (!artifacts.length) ui.info("No matching logs found.");
        for (const artifact of artifacts) {
          ui.info(`${artifact.name} (${artifact.path})`);
          process.stdout.write(await readFile(artifact.path, "utf8"));
        }
      });
    });

  program
    .command("diff")
    .description("Show the authoritative implementation diff")
    .argument("<run>", "run ID")
    .action(async (runId: string) => {
      await withStore(async (store) => {
        store.requireRun(runId);
        const artifact = store
          .artifacts(runId)
          .find((candidate) => candidate.name === "diff.patch");
        if (!artifact) throw new ProvenWayError("No diff exists for this run", 2, "DIFF_NOT_FOUND");
        process.stdout.write(await readFile(artifact.path, "utf8"));
      });
    });

  program
    .command("resume")
    .description("Resume an interrupted or blocked run from a safe boundary")
    .argument("<run>", "run ID")
    .action(async (runId: string) => {
      const controller = installSignalHandlers();
      try {
        await withStore(async (store, paths) => {
          const engine = new WorkflowEngine(
            paths,
            store,
            { codex: new CodexAdapter(), cursor: new CursorAdapter() },
            ui,
          );
          const outcome = await engine.resume(runId, controller.signal);
          renderOutcome(ui, outcome);
          process.exitCode = exitCodeForStatus(outcome.run.status);
        });
      } finally {
        controller.cleanup();
      }
    });

  program
    .command("cancel")
    .description("Cancel the active process for a run")
    .argument("<run>", "run ID")
    .action(async (runId: string) => {
      await withStore(async (store, paths) => {
        const run = store.requireRun(runId);
        if (isTerminal(run.status)) {
          throw new ProvenWayError(
            `Run is already terminal: ${run.status}`,
            2,
            "RUN_ALREADY_TERMINAL",
          );
        }
        const signalled = await cancelLockedRun(paths.locksDir, run.repositoryRoot, runId);
        if (!signalled) {
          store.forceInterrupted(runId, "cancel found no live ProvenWay process");
          ui.warn("No live process was found; the run was marked interrupted.");
        } else ui.success("Cancellation signal sent.");
      });
    });

  program
    .command("clean")
    .description("Remove a managed worktree and optionally its branch")
    .argument("<run>", "run ID")
    .option("--delete-branch", "also offer to delete the ProvenWay branch")
    .action(async (runId: string, options: { deleteBranch?: boolean }) => {
      await withStore(async (store, paths) => {
        const run = store.requireRun(runId);
        if (run.worktree && isPathInside(paths.worktreesDir, run.worktree)) {
          const registered = await isRegisteredWorktree(run.repositoryRoot, run.worktree);
          if (registered) {
            const confirmed = await ui.confirm(
              `Remove managed worktree ${run.worktree}? Uncommitted files there will be discarded.`,
              false,
            );
            if (!confirmed) throw new ProvenWayError("Cleanup cancelled", 130, "CANCELLED");
            await removeManagedWorktree(run.repositoryRoot, run.worktree, true);
          }
          store.clearWorktree(runId);
          ui.success("Managed worktree removed.");
        } else ui.info("No managed worktree is recorded for this run.");

        if (options.deleteBranch && run.branch) {
          const confirmed = await ui.confirm(
            `Delete branch ${run.branch}? This is separate and cannot be undone by ProvenWay.`,
            false,
          );
          if (!confirmed) throw new ProvenWayError("Branch deletion cancelled", 130, "CANCELLED");
          await deleteBranch(run.repositoryRoot, run.branch);
          store.clearBranch(runId);
          ui.success("ProvenWay branch deleted.");
        }
      });
    });

  program
    .command("delete")
    .description("Permanently delete a terminal run and its local artifacts")
    .argument("<run>", "run ID")
    .action(async (runId: string) => {
      await withStore(async (store, paths) => {
        const run = store.requireRun(runId);
        if (!isTerminal(run.status)) {
          throw new ProvenWayError(
            "Clean or finish the run before deleting it",
            2,
            "RUN_NOT_TERMINAL",
          );
        }
        if (run.worktree && (await isRegisteredWorktree(run.repositoryRoot, run.worktree))) {
          throw new ProvenWayError(
            "Remove the managed worktree with provenway clean before deleting this run",
            2,
            "WORKTREE_STILL_REGISTERED",
          );
        }
        const confirmed = await ui.confirm(
          `Permanently delete run ${runId} and its artifacts? This cannot be undone.`,
          false,
        );
        if (!confirmed) throw new ProvenWayError("Deletion cancelled", 130, "CANCELLED");
        const runDirectory = path.join(paths.runsDir, runId);
        if (!isPathInside(paths.runsDir, runDirectory)) {
          throw new ProvenWayError(
            "Run artifact path escaped managed storage",
            4,
            "RUN_PATH_ESCAPE",
          );
        }
        await rm(runDirectory, { recursive: true, force: true });
        store.deleteRun(runId);
        ui.success(`Deleted run ${runId}.`);
      });
    });

  const config = program.command("config").description("Inspect ProvenWay configuration");
  config
    .command("explain")
    .description("Show resolved configuration values and provenance")
    .action(async () => {
      const paths = resolveProvenWayPaths();
      let repositoryRoot: string | undefined;
      try {
        const { inspectRepository } = await import("./git.js");
        repositoryRoot = (await inspectRepository(process.cwd())).root;
      } catch {
        // Global configuration can be explained outside Git.
      }
      const resolved = await resolveConfiguration(paths, repositoryRoot);
      for (const [key, value] of flatten(resolved.config)) {
        ui.info(`${key} = ${JSON.stringify(value)}  [${resolved.provenance[key] ?? "derived"}]`);
      }
    });

  return program;
}

export async function runCli(
  argv: string[] = process.argv,
  ui: ProvenWayUi = new ConsoleUi(),
): Promise<number> {
  process.exitCode = 0;
  try {
    await buildProgram(ui).parseAsync(argv);
  } catch (error) {
    const provenwayError = asProvenWayError(error);
    ui.error(`${provenwayError.message} (${provenwayError.code})`);
    process.exitCode = provenwayError.exitCode;
  }
  return process.exitCode;
}

async function executeWorkflow(
  ui: ProvenWayUi,
  task: string,
  options: RunCommandOptions,
  planOnly: boolean,
): Promise<void> {
  const controller = installSignalHandlers();
  try {
    await withStore(async (store, paths) => {
      const engine = new WorkflowEngine(
        paths,
        store,
        { codex: new CodexAdapter(), cursor: new CursorAdapter() },
        ui,
      );
      const outcome = await engine.execute({
        cwd: process.cwd(),
        task,
        planOnly,
        overrides: toOverrides(options),
        signal: controller.signal,
      });
      renderOutcome(ui, outcome);
      process.exitCode = exitCodeForStatus(outcome.run.status);
    });
  } finally {
    controller.cleanup();
  }
}

function addWorkflowOptions(command: Command): Command {
  return command
    .option("--architect-model <model>", "override the architect model")
    .option("--implementer-model <model>", "override the implementer model")
    .option("--reviewer-model <model>", "override the reviewer model")
    .option("--repair-attempts <count>", "override repair attempts (0-2)", parseRepairAttempts)
    .addOption(
      new Option("--keep-worktree <policy>", "worktree retention policy").choices([
        "always",
        "on_failure",
        "never",
      ]),
    );
}

function toOverrides(options: RunCommandOptions): ConfigOverrides {
  return {
    ...(options.architectModel ? { architectModel: options.architectModel } : {}),
    ...(options.implementerModel ? { implementerModel: options.implementerModel } : {}),
    ...(options.reviewerModel ? { reviewerModel: options.reviewerModel } : {}),
    ...(options.repairAttempts !== undefined ? { repairAttempts: options.repairAttempts } : {}),
    ...(options.keepWorktree ? { keepWorktree: options.keepWorktree } : {}),
  };
}

function parseRepairAttempts(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2) {
    throw new ProvenWayError(
      "Repair attempts must be between 0 and 2",
      2,
      "INVALID_REPAIR_ATTEMPTS",
    );
  }
  return parsed;
}

async function withStore<T>(
  callback: (store: RunStore, paths: ReturnType<typeof resolveProvenWayPaths>) => T | Promise<T>,
): Promise<T> {
  const paths = resolveProvenWayPaths();
  await ensureProvenWayPaths(paths);
  const store = await RunStore.open(paths.databaseFile);
  try {
    return await callback(store, paths);
  } finally {
    store.close();
  }
}

function renderOutcome(ui: ProvenWayUi, outcome: WorkflowOutcome): void {
  const { run } = outcome;
  const requiredCommands =
    outcome.verification?.commands.filter((command) => command.required) ?? [];
  const passed = requiredCommands.filter((command) => command.exit_code === 0).length;
  ui.info(`Run: ${run.runId}`);
  ui.info(`Result: ${run.status}`);
  if (run.branch) ui.info(`Branch: ${run.branch}`);
  if (run.worktree) ui.info(`Worktree: ${run.worktree}`);
  if (outcome.verification)
    ui.info(`Tests: ${passed}/${requiredCommands.length} required checks passed`);
  if (outcome.review) {
    ui.info(
      `Review: ${outcome.review.findings.filter((item) => item.severity === "blocking").length} blocking findings`,
    );
  }
  ui.info(`Artifacts: ${path.join(resolveProvenWayPaths().runsDir, run.runId)}`);
  if (["accepted", "accepted_no_change", "planned"].includes(run.status)) ui.success(run.status);
  else ui.warn(run.status);
}

function renderRun(ui: ProvenWayUi, run: RunRecord): void {
  ui.info(
    [
      run.runId,
      run.status,
      run.branch ?? "no branch",
      run.updatedAt,
      JSON.stringify(run.task.length > 80 ? `${run.task.slice(0, 77)}...` : run.task),
    ].join("  "),
  );
}

function exitCodeForStatus(status: RunStatus): number {
  if (["accepted", "accepted_no_change", "planned"].includes(status)) return EXIT_CODES.accepted;
  if (["blocked_user", "blocked_auth", "blocked_quota", "interrupted"].includes(status)) {
    return EXIT_CODES.awaitingUser;
  }
  if (status === "cancelled") return EXIT_CODES.cancelled;
  if (status === "failed_verification") return EXIT_CODES.verification;
  if (status === "changes_requested") return EXIT_CODES.review;
  if (status === "failed_config") return EXIT_CODES.invalidInput;
  return EXIT_CODES.provider;
}

function installSignalHandlers(): AbortController & { cleanup(): void } {
  const controller = new AbortController() as AbortController & { cleanup(): void };
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  controller.cleanup = () => {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  };
  return controller;
}

function flatten(value: unknown, prefix = ""): Array<[string, unknown]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [[prefix, value]];
  return Object.entries(value).flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key),
  );
}
