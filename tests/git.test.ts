import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitWorktree,
  createManagedWorktree,
  gitChanges,
  inspectRepository,
  removeManagedWorktree,
  worktreeDiff,
} from "../src/git.js";
import { createGitRepository, git } from "./helpers.js";

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(temporary.splice(0).map((item) => rm(item, { recursive: true, force: true }))),
);

describe("Git worktree isolation", () => {
  it("retains accepted changes on a branch without changing the source checkout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "relay-git-"));
    temporary.push(root);
    const repository = await createGitRepository(root);
    const info = await inspectRepository(repository);
    const managedRoot = path.join(root, "managed");
    const location = await createManagedWorktree({
      repositoryRoot: repository,
      managedRoot,
      runId: "01TESTGIT",
      task: "Add isolated file",
      baseCommit: info.baseCommit,
    });
    await writeFile(path.join(location.worktree, "feature.txt"), "isolated\n");
    expect(await gitChanges(location.worktree)).toMatchObject({ created: ["feature.txt"] });
    expect(await worktreeDiff(location.worktree)).toContain("isolated");
    const finalCommit = await commitWorktree(location.worktree, "relay: test");
    await removeManagedWorktree(repository, location.worktree);
    expect(await git(repository, ["status", "--porcelain"])).toBe("");
    expect(await readFile(path.join(repository, "README.md"), "utf8")).toBe("# Fixture\n");
    expect(await git(repository, ["show", `${finalCommit}:feature.txt`])).toBe("isolated");
  });
});
