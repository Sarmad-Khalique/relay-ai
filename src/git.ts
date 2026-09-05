import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { EXIT_CODES, ProvenWayError } from "./errors.js";
import { assertRealPathInside, isPathInside } from "./paths.js";

const execFile = promisify(execFileCallback);

export interface RepositoryInfo {
  root: string;
  baseCommit: string;
  currentBranch: string;
  defaultBranch: string;
  clean: boolean;
  status: string;
  languages: string[];
}

export interface GitChanges {
  changed: string[];
  created: string[];
  deleted: string[];
  all: string[];
}

export async function inspectRepository(cwd: string): Promise<RepositoryInfo> {
  let root: string;
  try {
    root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new ProvenWayError(
      `${cwd} is not inside a Git repository`,
      EXIT_CODES.invalidInput,
      "NOT_A_GIT_REPOSITORY",
    );
  }
  root = await realpath(root);
  const [baseCommit, currentBranch, status, files] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["branch", "--show-current"]),
    git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(root, ["ls-files"]),
  ]);
  if (!baseCommit) {
    throw new ProvenWayError(
      "ProvenWay requires a repository with at least one commit",
      EXIT_CODES.invalidInput,
      "EMPTY_GIT_HISTORY",
    );
  }
  return {
    root,
    baseCommit,
    currentBranch: currentBranch || "HEAD",
    defaultBranch: await detectDefaultBranch(root, currentBranch),
    clean: status === "",
    status,
    languages: detectLanguages(files.split("\n").filter(Boolean)),
  };
}

export async function verifyRepositoryUnchanged(
  root: string,
  baseCommit: string,
  requireClean: boolean,
): Promise<void> {
  const [head, status] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  if (head !== baseCommit) {
    throw new ProvenWayError(
      "Repository HEAD changed after planning; start a new run",
      EXIT_CODES.awaitingUser,
      "BASE_COMMIT_CHANGED",
    );
  }
  if (requireClean && status !== "") {
    throw new ProvenWayError(
      "Repository became dirty after planning; start a new run after resolving changes",
      EXIT_CODES.awaitingUser,
      "SOURCE_CHECKOUT_CHANGED",
    );
  }
}

export async function createManagedWorktree(input: {
  repositoryRoot: string;
  managedRoot: string;
  runId: string;
  task: string;
  baseCommit: string;
}): Promise<{ branch: string; worktree: string }> {
  await mkdir(input.managedRoot, { recursive: true, mode: 0o700 });
  await assertRealPathInside(input.managedRoot, input.managedRoot);
  const branch = await uniqueBranch(input.repositoryRoot, input.runId, input.task);
  const realManagedRoot = await realpath(input.managedRoot);
  const worktree = path.join(realManagedRoot, input.runId);
  if (!isPathInside(realManagedRoot, worktree)) {
    throw new ProvenWayError(
      "Managed worktree path escaped its root",
      EXIT_CODES.provider,
      "WORKTREE_PATH_ESCAPE",
    );
  }
  try {
    await stat(worktree);
    throw new ProvenWayError(
      `Worktree target already exists: ${worktree}`,
      EXIT_CODES.provider,
      "WORKTREE_TARGET_EXISTS",
    );
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
  }
  await git(input.repositoryRoot, ["worktree", "add", "-b", branch, worktree, input.baseCommit]);
  const registered = await git(input.repositoryRoot, ["worktree", "list", "--porcelain"]);
  if (
    !registered.includes(`worktree ${worktree}`) ||
    !registered.includes(`branch refs/heads/${branch}`)
  ) {
    throw new ProvenWayError(
      "Git did not register the expected managed worktree",
      EXIT_CODES.provider,
      "WORKTREE_REGISTRATION_FAILED",
    );
  }
  await assertRealPathInside(input.managedRoot, worktree);
  return { branch, worktree };
}

export async function gitChanges(worktree: string): Promise<GitChanges> {
  const [tracked, untracked] = await Promise.all([
    git(worktree, ["diff", "--name-status", "-z", "HEAD", "--"]),
    git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const changed = new Set<string>();
  const created = new Set<string>();
  const deleted = new Set<string>();
  const tokens = tracked.split("\0").filter(Boolean);
  for (let index = 0; index < tokens.length; index += 2) {
    const status = tokens[index];
    const candidate = tokens[index + 1];
    if (!status || !candidate) continue;
    const code = status[0];
    if (code === "A") created.add(candidate);
    else if (code === "D") deleted.add(candidate);
    else if (code === "R" || code === "C") {
      const destination = tokens[index + 2];
      deleted.add(candidate);
      if (destination) {
        created.add(destination);
        index += 1;
      }
    } else changed.add(candidate);
  }
  for (const candidate of untracked.split("\0").filter(Boolean)) created.add(candidate);
  const all = [...new Set([...changed, ...created, ...deleted])].sort();
  return {
    changed: [...changed].sort(),
    created: [...created].sort(),
    deleted: [...deleted].sort(),
    all,
  };
}

export async function worktreeDiff(worktree: string): Promise<string> {
  await git(worktree, ["add", "-N", "--", "."]);
  return git(worktree, ["diff", "--binary", "--no-ext-diff", "HEAD", "--"]);
}

export async function commitWorktree(worktree: string, message: string): Promise<string> {
  await git(worktree, ["add", "-A", "--", "."]);
  const name = await gitOptional(worktree, ["config", "--get", "user.name"]);
  const email = await gitOptional(worktree, ["config", "--get", "user.email"]);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!name) {
    env.GIT_AUTHOR_NAME = "ProvenWay";
    env.GIT_COMMITTER_NAME = "ProvenWay";
  }
  if (!email) {
    env.GIT_AUTHOR_EMAIL = "provenway@localhost";
    env.GIT_COMMITTER_EMAIL = "provenway@localhost";
  }
  await git(worktree, ["commit", "--no-gpg-sign", "-m", message], env);
  return git(worktree, ["rev-parse", "HEAD"]);
}

export async function removeManagedWorktree(
  repositoryRoot: string,
  worktree: string,
  force = false,
): Promise<void> {
  await git(repositoryRoot, ["worktree", "remove", ...(force ? ["--force"] : []), worktree]);
}

export async function deleteBranch(repositoryRoot: string, branch: string): Promise<void> {
  await git(repositoryRoot, ["branch", "-D", branch]);
}

export async function isRegisteredWorktree(
  repositoryRoot: string,
  worktree: string,
): Promise<boolean> {
  const registered = await git(repositoryRoot, ["worktree", "list", "--porcelain"]);
  return registered.includes(`worktree ${worktree}`);
}

export async function git(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  try {
    const result = await execFile("git", args, {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return result.stdout.trimEnd();
  } catch (error) {
    const stderr = isExecError(error) ? error.stderr : undefined;
    throw new ProvenWayError(
      `git ${args[0] ?? "command"} failed${stderr ? `: ${stderr.trim()}` : ""}`,
      EXIT_CODES.provider,
      "GIT_COMMAND_FAILED",
      { args },
    );
  }
}

async function uniqueBranch(repositoryRoot: string, runId: string, task: string): Promise<string> {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const base = `provenway/${runId.slice(0, 8).toLowerCase()}-${slug || "task"}`;
  let candidate = base;
  let suffix = 1;
  while (await branchExists(repositoryRoot, candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

async function branchExists(repositoryRoot: string, branch: string): Promise<boolean> {
  try {
    await git(repositoryRoot, ["show-ref", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function detectDefaultBranch(root: string, current: string): Promise<string> {
  const remote = await gitOptional(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remote?.startsWith("origin/")) return remote.slice("origin/".length);
  return current || "main";
}

async function gitOptional(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}

function detectLanguages(files: string[]): string[] {
  const detected = new Set<string>();
  const mapping: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".rb": "ruby",
  };
  for (const file of files) {
    const language = mapping[path.extname(file).toLowerCase()];
    if (language) detected.add(language);
  }
  return [...detected].sort();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isExecError(error: unknown): error is Error & { stderr?: string } {
  return error instanceof Error && "stderr" in error;
}
