import Database from "better-sqlite3";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ArtifactMetadata } from "./artifacts.js";
import { assertTransition, type RunStatus } from "./state-machine.js";

export interface RunRecord {
  runId: string;
  task: string;
  status: RunStatus;
  repositoryRoot: string;
  baseCommit: string;
  branch: string | null;
  worktree: string | null;
  finalCommit: string | null;
  repairCount: number;
  configuration: unknown;
  providers: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface TransitionRecord {
  from: RunStatus | null;
  to: RunStatus;
  at: string;
  detail?: string;
}

interface RunRow {
  run_id: string;
  task: string;
  status: RunStatus;
  repository_root: string;
  base_commit: string;
  branch: string | null;
  worktree: string | null;
  final_commit: string | null;
  repair_count: number;
  configuration_json: string;
  providers_json: string;
  created_at: string;
  updated_at: string;
}

interface TransitionRow {
  from_status: RunStatus | null;
  to_status: RunStatus;
  at: string;
  detail: string | null;
}

interface ArtifactRow {
  name: string;
  path: string;
  sha256: string;
  bytes: number;
  media_type: string;
  stage: string;
}

export class RunStore {
  private readonly database: Database.Database;

  private constructor(database: Database.Database) {
    this.database = database;
  }

  static async open(databaseFile: string): Promise<RunStore> {
    await mkdir(path.dirname(databaseFile), { recursive: true, mode: 0o700 });
    const database = new Database(databaseFile);
    await chmod(databaseFile, 0o600);
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    const store = new RunStore(database);
    store.migrate();
    return store;
  }

  close(): void {
    this.database.close();
  }

  createRun(input: {
    runId: string;
    task: string;
    repositoryRoot: string;
    baseCommit: string;
    configuration: unknown;
  }): RunRecord {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO runs (
          run_id, task, status, repository_root, base_commit, repair_count,
          configuration_json, providers_json, created_at, updated_at
        ) VALUES (?, ?, 'created', ?, ?, 0, ?, '{}', ?, ?)`,
      )
      .run(
        input.runId,
        input.task,
        input.repositoryRoot,
        input.baseCommit,
        JSON.stringify(input.configuration),
        now,
        now,
      );
    this.database
      .prepare(
        "INSERT INTO transitions (run_id, from_status, to_status, at, detail) VALUES (?, NULL, 'created', ?, ?)",
      )
      .run(input.runId, now, "run created");
    return this.requireRun(input.runId);
  }

  transition(runId: string, to: RunStatus, detail?: string): RunRecord {
    return this.database.transaction(() => {
      const current = this.requireRun(runId);
      assertTransition(current.status, to);
      const now = new Date().toISOString();
      this.database
        .prepare("UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?")
        .run(to, now, runId);
      this.database
        .prepare(
          "INSERT INTO transitions (run_id, from_status, to_status, at, detail) VALUES (?, ?, ?, ?, ?)",
        )
        .run(runId, current.status, to, now, detail ?? null);
      return this.requireRun(runId);
    })();
  }

  forceInterrupted(runId: string, detail: string): RunRecord {
    const current = this.requireRun(runId);
    const now = new Date().toISOString();
    this.database
      .prepare("UPDATE runs SET status = 'interrupted', updated_at = ? WHERE run_id = ?")
      .run(now, runId);
    this.database
      .prepare(
        "INSERT INTO transitions (run_id, from_status, to_status, at, detail) VALUES (?, ?, 'interrupted', ?, ?)",
      )
      .run(runId, current.status, now, detail);
    return this.requireRun(runId);
  }

  forceStatus(runId: string, status: RunStatus, detail: string): RunRecord {
    const current = this.requireRun(runId);
    const now = new Date().toISOString();
    this.database
      .prepare("UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?")
      .run(status, now, runId);
    this.database
      .prepare(
        "INSERT INTO transitions (run_id, from_status, to_status, at, detail) VALUES (?, ?, ?, ?, ?)",
      )
      .run(runId, current.status, status, now, detail);
    return this.requireRun(runId);
  }

  setLocations(runId: string, branch: string, worktree: string): void {
    this.database
      .prepare("UPDATE runs SET branch = ?, worktree = ?, updated_at = ? WHERE run_id = ?")
      .run(branch, worktree, new Date().toISOString(), runId);
  }

  clearWorktree(runId: string): void {
    this.database
      .prepare("UPDATE runs SET worktree = NULL, updated_at = ? WHERE run_id = ?")
      .run(new Date().toISOString(), runId);
  }

  clearBranch(runId: string): void {
    this.database
      .prepare("UPDATE runs SET branch = NULL, updated_at = ? WHERE run_id = ?")
      .run(new Date().toISOString(), runId);
  }

  setFinalCommit(runId: string, finalCommit: string): void {
    this.database
      .prepare("UPDATE runs SET final_commit = ?, updated_at = ? WHERE run_id = ?")
      .run(finalCommit, new Date().toISOString(), runId);
  }

  setProviders(runId: string, providers: unknown): void {
    this.database
      .prepare("UPDATE runs SET providers_json = ?, updated_at = ? WHERE run_id = ?")
      .run(JSON.stringify(providers), new Date().toISOString(), runId);
  }

  setRepairCount(runId: string, count: number): void {
    this.database
      .prepare("UPDATE runs SET repair_count = ?, updated_at = ? WHERE run_id = ?")
      .run(count, new Date().toISOString(), runId);
  }

  addStage(input: {
    runId: string;
    name: string;
    status: "starting" | "completed" | "failed" | "interrupted";
    detail?: unknown;
  }): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO stages (run_id, name, status, started_at, finished_at, detail_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.name,
        input.status,
        now,
        input.status === "starting" ? null : now,
        input.detail === undefined ? null : JSON.stringify(input.detail),
      );
  }

  addInvocation(input: {
    runId: string;
    stage: string;
    adapter: string;
    executable: string;
    args: string[];
    startedAt: string;
    finishedAt: string;
    exitCode: number | null;
    signal: string | null;
    sessionId?: string;
  }): void {
    this.database
      .prepare(
        `INSERT INTO provider_invocations (
          run_id, stage, adapter, executable, args_json, started_at, finished_at,
          exit_code, signal, session_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.stage,
        input.adapter,
        input.executable,
        JSON.stringify(input.args),
        input.startedAt,
        input.finishedAt,
        input.exitCode,
        input.signal,
        input.sessionId ?? null,
      );
  }

  addArtifact(runId: string, artifact: ArtifactMetadata): void {
    this.database
      .prepare(
        `INSERT INTO artifacts (run_id, name, path, sha256, bytes, media_type, stage)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, name) DO UPDATE SET
           path=excluded.path, sha256=excluded.sha256, bytes=excluded.bytes,
           media_type=excluded.media_type, stage=excluded.stage`,
      )
      .run(
        runId,
        artifact.name,
        artifact.path,
        artifact.sha256,
        artifact.bytes,
        artifact.media_type,
        artifact.stage,
      );
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.database.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as
      RunRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  requireRun(runId: string): RunRecord {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run;
  }

  latestRun(): RunRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT 1")
      .get() as RunRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  listRuns(limit = 25): RunRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?")
      .all(limit) as RunRow[];
    return rows.map(mapRun);
  }

  transitions(runId: string): TransitionRecord[] {
    const rows = this.database
      .prepare(
        "SELECT from_status, to_status, at, detail FROM transitions WHERE run_id = ? ORDER BY id",
      )
      .all(runId) as TransitionRow[];
    return rows.map((row) => ({
      from: row.from_status,
      to: row.to_status,
      at: row.at,
      ...(row.detail ? { detail: row.detail } : {}),
    }));
  }

  artifacts(runId: string): ArtifactMetadata[] {
    return (
      this.database
        .prepare(
          "SELECT name, path, sha256, bytes, media_type, stage FROM artifacts WHERE run_id = ?",
        )
        .all(runId) as ArtifactRow[]
    ).map((row) => ({ ...row }));
  }

  deleteRun(runId: string): void {
    this.database.prepare("DELETE FROM runs WHERE run_id = ?").run(runId);
  }

  findActiveByRepository(repositoryRoot: string): RunRecord[] {
    const terminal = [
      "accepted",
      "accepted_no_change",
      "planned",
      "cancelled",
      "failed_config",
      "failed_provider",
      "failed_policy",
      "failed_verification",
      "changes_requested",
      "implemented_unreviewed",
    ];
    const placeholders = terminal.map(() => "?").join(",");
    const rows = this.database
      .prepare(
        `SELECT * FROM runs WHERE repository_root = ? AND status NOT IN (${placeholders}) ORDER BY created_at DESC`,
      )
      .all(repositoryRoot, ...terminal) as RunRow[];
    return rows.map(mapRun);
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        repository_root TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        branch TEXT,
        worktree TEXT,
        final_commit TEXT,
        repair_count INTEGER NOT NULL DEFAULT 0,
        configuration_json TEXT NOT NULL,
        providers_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_repository_status ON runs(repository_root, status);
      CREATE TABLE IF NOT EXISTS stages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        detail_json TEXT
      );
      CREATE TABLE IF NOT EXISTS provider_invocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        adapter TEXT NOT NULL,
        executable TEXT NOT NULL,
        args_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        exit_code INTEGER,
        signal TEXT,
        session_id TEXT
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        stage TEXT NOT NULL,
        UNIQUE(run_id, name)
      );
      CREATE TABLE IF NOT EXISTS transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        from_status TEXT,
        to_status TEXT NOT NULL,
        at TEXT NOT NULL,
        detail TEXT
      );
    `);
  }
}

function mapRun(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    task: row.task,
    status: row.status,
    repositoryRoot: row.repository_root,
    baseCommit: row.base_commit,
    branch: row.branch,
    worktree: row.worktree,
    finalCommit: row.final_commit,
    repairCount: row.repair_count,
    configuration: JSON.parse(row.configuration_json) as unknown,
    providers: JSON.parse(row.providers_json) as unknown,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
