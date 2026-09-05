import { execFile as execFileCallback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ProvenWayPaths } from "../src/paths.js";
import type { ProvenWayUi } from "../src/ui.js";

const execFile = promisify(execFileCallback);

export function testPaths(root: string): ProvenWayPaths {
  const configDir = path.join(root, "config", "provenway");
  const dataDir = path.join(root, "data", "provenway");
  return {
    configDir,
    configFile: path.join(configDir, "config.yaml"),
    dataDir,
    databaseFile: path.join(dataDir, "provenway.sqlite"),
    runsDir: path.join(dataDir, "runs"),
    worktreesDir: path.join(dataDir, "worktrees"),
    locksDir: path.join(dataDir, "locks"),
  };
}

export async function createGitRepository(root: string): Promise<string> {
  const repository = path.join(root, "repository");
  await mkdir(repository, { recursive: true });
  await git(repository, ["init", "-b", "main"]);
  await writeFile(path.join(repository, "README.md"), "# Fixture\n", "utf8");
  await git(repository, ["add", "README.md"]);
  await git(repository, [
    "-c",
    "user.name=ProvenWay Tests",
    "-c",
    "user.email=provenway-tests@localhost",
    "commit",
    "-m",
    "fixture",
  ]);
  return repository;
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

export class TestUi implements ProvenWayUi {
  readonly interactive = true;
  readonly messages: string[] = [];
  readonly answers: string[] = [];
  confirmAnswer = true;

  info(message: string): void {
    this.messages.push(message);
  }
  warn(message: string): void {
    this.messages.push(message);
  }
  error(message: string): void {
    this.messages.push(message);
  }
  success(message: string): void {
    this.messages.push(message);
  }
  async confirm(): Promise<boolean> {
    return this.confirmAnswer;
  }
  async input(): Promise<string> {
    return this.answers.shift() ?? "test answer";
  }
  async select(_message: string, options: Array<{ value: string }>): Promise<string> {
    return options[0]?.value ?? "test-model";
  }
}
