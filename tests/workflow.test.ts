import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  EventSink,
  HarnessAdapter,
  HarnessResumeRequest,
  HarnessRunRequest,
  HarnessRunResult,
  ProbeContext,
  ProviderCapabilities,
} from "../src/adapter-contract.js";
import { DEFAULT_CONFIG, writeGlobalConfig } from "../src/config.js";
import { RunStore } from "../src/store.js";
import { WorkflowEngine } from "../src/workflow.js";
import { createGitRepository, git, TestUi, testPaths } from "./helpers.js";

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(temporary.splice(0).map((item) => rm(item, { recursive: true, force: true }))),
);

describe("workflow engine", () => {
  it("completes plan, isolated implementation, verification, review, and branch finalization", async () => {
    const fixture = await setupFixture();
    const outcome = await fixture.engine.execute({
      cwd: fixture.repository,
      task: "Add a fixture feature",
    });
    expect(outcome.run.status).toBe("accepted");
    expect(outcome.run.branch).toMatch(/^provenway\//);
    expect(await git(fixture.repository, ["status", "--porcelain"])).toBe("");
    await expect(access(path.join(fixture.repository, "feature.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await git(fixture.repository, ["show", `${outcome.run.branch}:feature.txt`])).toContain(
      "implemented",
    );
    if (!outcome.run.worktree) throw new Error("expected recorded worktree");
    await expect(access(outcome.run.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.store.artifacts(outcome.run.runId).map((item) => item.name)).toContain(
      "diff.patch",
    );
    const manifest = JSON.parse(
      await readFile(
        path.join(fixture.paths.runsDir, outcome.run.runId, "run-manifest.json"),
        "utf8",
      ),
    ) as { final_commit: string | null };
    const implementation = JSON.parse(
      await readFile(
        path.join(fixture.paths.runsDir, outcome.run.runId, "implementation-result.json"),
        "utf8",
      ),
    ) as { final_commit: string | null };
    expect(manifest.final_commit).toBe(outcome.run.finalCommit);
    expect(implementation.final_commit).toBe(outcome.run.finalCommit);
    fixture.store.close();
  });

  it("runs one targeted repair and rereviews before acceptance", async () => {
    const fixture = await setupFixture({ blockFirstReview: true });
    const outcome = await fixture.engine.execute({
      cwd: fixture.repository,
      task: "Repair a feature",
    });
    expect(outcome.run.status).toBe("accepted");
    expect(outcome.run.repairCount).toBe(1);
    expect(fixture.cursor.resumeCount).toBe(1);
    expect(fixture.codex.reviewCount).toBe(2);
    expect(await git(fixture.repository, ["show", `${outcome.run.branch}:feature.txt`])).toContain(
      "repaired",
    );
    fixture.store.close();
  });

  it("fails immediately when a provider modifies a forbidden path", async () => {
    const fixture = await setupFixture({ writeForbidden: true });
    await expect(
      fixture.engine.execute({ cwd: fixture.repository, task: "Attempt a forbidden change" }),
    ).rejects.toThrow("forbidden paths");
    expect(fixture.store.latestRun()?.status).toBe("failed_policy");
    expect(await git(fixture.repository, ["status", "--porcelain"])).toBe("");
    fixture.store.close();
  });

  it("supports plan-only runs without probing the writer", async () => {
    const fixture = await setupFixture();
    fixture.cursor.installed = false;
    const outcome = await fixture.engine.execute({
      cwd: fixture.repository,
      task: "Plan a feature",
      planOnly: true,
    });
    expect(outcome.run.status).toBe("planned");
    expect(fixture.cursor.probeCount).toBe(0);
    fixture.store.close();
  });

  it("accepts an explicit no-change plan without invoking Cursor", async () => {
    const fixture = await setupFixture({ noChange: true });
    const outcome = await fixture.engine.execute({ cwd: fixture.repository, task: "Check status" });
    expect(outcome.run.status).toBe("accepted_no_change");
    expect(outcome.run.branch).toBeNull();
    expect(fixture.cursor.startCount).toBe(0);
    expect(await git(fixture.repository, ["status", "--porcelain"])).toBe("");
    fixture.store.close();
  });

  it("stops for blocking planning questions before the write confirmation", async () => {
    const fixture = await setupFixture({ blockingQuestion: true });
    const outcome = await fixture.engine.execute({
      cwd: fixture.repository,
      task: "Ambiguous task",
    });
    expect(outcome.run.status).toBe("blocked_user");
    expect(fixture.cursor.startCount).toBe(0);
    fixture.store.close();
  });

  it("retains the isolated worktree after verification failure exhausts two repairs", async () => {
    const fixture = await setupFixture({ verificationFails: true });
    const outcome = await fixture.engine.execute({
      cwd: fixture.repository,
      task: "Implement something that cannot verify",
    });
    expect(outcome.run.status).toBe("failed_verification");
    expect(outcome.run.repairCount).toBe(2);
    expect(fixture.cursor.resumeCount).toBe(2);
    expect(await git(fixture.repository, ["status", "--porcelain"])).toBe("");
    if (!outcome.run.worktree) throw new Error("expected retained failed worktree");
    await expect(access(outcome.run.worktree)).resolves.toBeUndefined();
    fixture.store.close();
  });

  it("rejects dirty source checkouts without creating a run", async () => {
    const fixture = await setupFixture();
    await writeFile(path.join(fixture.repository, "dirty.txt"), "dirty\n");
    await expect(
      fixture.engine.execute({ cwd: fixture.repository, task: "Should not start" }),
    ).rejects.toThrow("Source checkout is not clean");
    expect(fixture.store.latestRun()).toBeUndefined();
    fixture.store.close();
  });
});

async function setupFixture(
  options: {
    blockFirstReview?: boolean;
    writeForbidden?: boolean;
    noChange?: boolean;
    blockingQuestion?: boolean;
    verificationFails?: boolean;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "provenway-workflow-"));
  temporary.push(root);
  const repository = await createGitRepository(root);
  const paths = testPaths(root);
  const config = structuredClone(DEFAULT_CONFIG);
  config.roles.architect.model = "test-model";
  config.roles.implementer.model = "test-model";
  config.roles.reviewer.model = "test-model";
  if (options.verificationFails) {
    config.verification.discover = false;
    config.verification.commands = [
      {
        name: "intentional failure",
        argv: [process.execPath, "-e", "process.exit(1)"],
        timeout_seconds: 10,
        required: true,
      },
    ];
  }
  await writeGlobalConfig(paths, config);
  const store = await RunStore.open(paths.databaseFile);
  const codex = new FakeCodexAdapter({
    blockFirstReview: Boolean(options.blockFirstReview),
    noChange: Boolean(options.noChange),
    blockingQuestion: Boolean(options.blockingQuestion),
  });
  const cursor = new FakeCursorAdapter(Boolean(options.writeForbidden));
  const engine = new WorkflowEngine(paths, store, { codex, cursor }, new TestUi());
  return { root, repository, paths, store, codex, cursor, engine };
}

abstract class FakeAdapterBase implements HarnessAdapter {
  abstract readonly id: string;
  installed = true;
  probeCount = 0;

  async probe(_context: ProbeContext): Promise<ProviderCapabilities> {
    this.probeCount += 1;
    return {
      installed: this.installed,
      executable: `fake-${this.id}`,
      version: "1.0.0",
      authenticated: true,
      authMode: "account",
      models: "discoverable",
      availableModels: ["test-model"],
      supportsJsonEvents: true,
      supportsOutputSchema: this.id === "codex",
      supportsResume: true,
      permissionModes: this.id === "codex" ? ["read-only"] : ["workspace-write"],
      warnings: [],
    };
  }

  abstract start(request: HarnessRunRequest, sink: EventSink): Promise<HarnessRunResult>;

  async resume(request: HarnessResumeRequest, sink: EventSink): Promise<HarnessRunResult> {
    return this.start(request, sink);
  }

  async cancel(_runId: string): Promise<void> {}

  protected async result(request: HarnessRunRequest, finalText: string): Promise<HarnessRunResult> {
    await mkdir(request.logDirectory, { recursive: true });
    const stdoutPath = path.join(request.logDirectory, `${request.stage}.stdout.ndjson`);
    const stderrPath = path.join(request.logDirectory, `${request.stage}.stderr.log`);
    await writeFile(stdoutPath, "");
    await writeFile(stderrPath, "");
    const now = new Date().toISOString();
    return {
      adapterId: this.id,
      executable: `fake-${this.id}`,
      args: [request.stage],
      sessionId: `${this.id}-session`,
      finalText,
      exitCode: 0,
      signal: null,
      startedAt: now,
      finishedAt: now,
      durationMs: 1,
      stdoutPath,
      stderrPath,
      events: [],
      authMode: "account",
    };
  }
}

class FakeCodexAdapter extends FakeAdapterBase {
  readonly id = "codex";
  reviewCount = 0;

  constructor(
    private readonly options: {
      blockFirstReview: boolean;
      noChange: boolean;
      blockingQuestion: boolean;
    },
  ) {
    super();
  }

  async start(request: HarnessRunRequest, _sink: EventSink): Promise<HarnessRunResult> {
    const taskId = /Task ID: ([^\n]+)/.exec(request.prompt)?.[1] ?? extractTaskId(request.prompt);
    if (request.stage.includes("plan")) {
      const baseCommit = /Base commit: ([a-f0-9]+)/.exec(request.prompt)?.[1] ?? "abcdef1";
      return this.result(
        request,
        JSON.stringify({
          schema_version: "1.0",
          task_id: taskId,
          goal: "Fixture feature",
          change_required: !this.options.noChange,
          repo_facts: { base_commit: baseCommit, default_branch: "main", languages: [] },
          constraints: [],
          acceptance_criteria: [
            { id: "AC-1", text: "feature.txt exists", verification: "inspection" },
          ],
          steps: [{ id: "S-1", description: "Create feature", likely_paths: ["feature.txt"] }],
          required_tests: [],
          forbidden_paths: ["**/.env*", "**/*.pem", "**/*.key", ".git/**"],
          open_questions: this.options.blockingQuestion
            ? [{ id: "Q-1", text: "Which behavior is intended?", blocking: true }]
            : [],
          risk_notes: [],
        }),
      );
    }
    this.reviewCount += 1;
    const blocking = this.options.blockFirstReview && this.reviewCount === 1;
    return this.result(
      request,
      JSON.stringify({
        schema_version: "1.0",
        task_id: taskId,
        verdict: blocking ? "changes_requested" : "accepted",
        summary: blocking ? "repair requested" : "looks good",
        findings: blocking
          ? [
              {
                id: "R-1",
                severity: "blocking",
                path: "feature.txt",
                line: 1,
                title: "Needs repair",
                evidence: "Fixture requires a repair marker",
                required_change: "Add the repair marker",
              },
            ]
          : [],
      }),
    );
  }
}

class FakeCursorAdapter extends FakeAdapterBase {
  readonly id = "cursor";
  resumeCount = 0;
  startCount = 0;

  constructor(private readonly writeForbidden: boolean) {
    super();
  }

  async start(request: HarnessRunRequest, _sink: EventSink): Promise<HarnessRunResult> {
    this.startCount += 1;
    const target = this.writeForbidden ? ".env" : "feature.txt";
    await writeFile(path.join(request.cwd, target), "implemented\n");
    return this.result(
      request,
      JSON.stringify({
        commands: [],
        paths: { changed: [], created: [target], deleted: [] },
        acceptance_criteria_addressed: ["AC-1"],
        deviations: [],
        unresolved_items: [],
      }),
    );
  }

  override async resume(
    request: HarnessResumeRequest,
    _sink: EventSink,
  ): Promise<HarnessRunResult> {
    this.resumeCount += 1;
    await writeFile(path.join(request.cwd, "feature.txt"), "implemented\nrepaired\n");
    return this.result(request, "repair complete");
  }
}

function extractTaskId(prompt: string): string {
  return /"task_id":\s*"([^"]+)"/.exec(prompt)?.[1] ?? "missing-task-id";
}
