import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyCursorOverlay, restoreCursorOverlay } from "../src/cursor-overlay.js";

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(temporary.splice(0).map((item) => rm(item, { recursive: true, force: true }))),
);

describe("Cursor permission overlay", () => {
  it("tightens and restores an existing file byte-for-byte", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "relay-overlay-"));
    temporary.push(root);
    const worktree = path.join(root, "worktree");
    const runDirectory = path.join(root, "run");
    await mkdir(path.join(worktree, ".cursor"), { recursive: true });
    const original = '{"permissions":{"deny":["Shell(custom)"]}}\n';
    await writeFile(path.join(worktree, ".cursor", "cli.json"), original, { mode: 0o640 });
    await applyCursorOverlay(worktree, runDirectory, ["private/**"]);
    const applied = JSON.parse(
      await readFile(path.join(worktree, ".cursor", "cli.json"), "utf8"),
    ) as {
      permissions: { deny: string[] };
    };
    expect(applied.permissions.deny).toContain("Write(private/**)");
    await restoreCursorOverlay(worktree, runDirectory);
    expect(await readFile(path.join(worktree, ".cursor", "cli.json"), "utf8")).toBe(original);
    expect((await lstat(path.join(worktree, ".cursor", "cli.json"))).mode & 0o777).toBe(0o640);
  });

  it("removes a Relay-created overlay", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "relay-overlay-"));
    temporary.push(root);
    const worktree = path.join(root, "worktree");
    await mkdir(worktree);
    await applyCursorOverlay(worktree, path.join(root, "run"), []);
    await restoreCursorOverlay(worktree, path.join(root, "run"));
    await expect(lstat(path.join(worktree, ".cursor", "cli.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
