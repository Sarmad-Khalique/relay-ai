import { chmod, lstat, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { EXIT_CODES, ProvenWayError } from "./errors.js";
import { isPathInside } from "./paths.js";
import { mergeCursorDenyPermissions } from "./policy.js";

interface OverlayBackup {
  existed: boolean;
  contentBase64?: string;
  mode?: number;
}

export function overlayBackupPath(runDirectory: string): string {
  return path.join(runDirectory, "internal", "cursor-overlay-backup.json");
}

export async function applyCursorOverlay(
  worktree: string,
  runDirectory: string,
  forbiddenPaths: readonly string[],
): Promise<void> {
  const cursorDirectory = path.join(worktree, ".cursor");
  const overlayPath = path.join(cursorDirectory, "cli.json");
  if (!isPathInside(worktree, overlayPath)) throwPathEscape();

  let backup: OverlayBackup = { existed: false };
  let existing: unknown = {};
  try {
    const info = await lstat(overlayPath);
    if (info.isSymbolicLink()) {
      throw new ProvenWayError(
        "Refusing to replace a symlinked Cursor permission file",
        EXIT_CODES.provider,
        "CURSOR_OVERLAY_SYMLINK",
      );
    }
    const content = await readFile(overlayPath);
    backup = { existed: true, contentBase64: content.toString("base64"), mode: info.mode };
    try {
      existing = JSON.parse(content.toString("utf8")) as unknown;
    } catch {
      throw new ProvenWayError(
        "Existing .cursor/cli.json is invalid JSON",
        EXIT_CODES.invalidInput,
        "INVALID_CURSOR_CONFIG",
      );
    }
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
  }

  const backupFile = overlayBackupPath(runDirectory);
  await mkdir(path.dirname(backupFile), { recursive: true, mode: 0o700 });
  await writeFile(backupFile, `${JSON.stringify(backup)}\n`, { mode: 0o600 });
  await chmod(backupFile, 0o600);

  await mkdir(cursorDirectory, { recursive: true, mode: 0o700 });
  const merged = mergeCursorDenyPermissions(existing, forbiddenPaths);
  await writeFile(overlayPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  await chmod(overlayPath, 0o600);
}

export async function restoreCursorOverlay(worktree: string, runDirectory: string): Promise<void> {
  const backupFile = overlayBackupPath(runDirectory);
  let backup: OverlayBackup;
  try {
    backup = JSON.parse(await readFile(backupFile, "utf8")) as OverlayBackup;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }

  const cursorDirectory = path.join(worktree, ".cursor");
  const overlayPath = path.join(cursorDirectory, "cli.json");
  if (!isPathInside(worktree, overlayPath)) throwPathEscape();
  if (backup.existed) {
    if (!backup.contentBase64) throw new Error("Cursor overlay backup is incomplete");
    await mkdir(cursorDirectory, { recursive: true, mode: 0o700 });
    await writeFile(overlayPath, Buffer.from(backup.contentBase64, "base64"), {
      mode: backup.mode ?? 0o600,
    });
    await chmod(overlayPath, backup.mode ?? 0o600);
  } else {
    await rm(overlayPath, { force: true });
    try {
      await rmdir(cursorDirectory);
    } catch (error) {
      if (!(isNodeError(error) && ["ENOTEMPTY", "ENOENT"].includes(error.code ?? ""))) throw error;
    }
  }
  await rm(backupFile, { force: true });
}

function throwPathEscape(): never {
  throw new ProvenWayError(
    "Cursor overlay path escaped the worktree",
    EXIT_CODES.provider,
    "CURSOR_OVERLAY_PATH_ESCAPE",
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
