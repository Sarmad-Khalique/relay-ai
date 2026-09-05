import { open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./artifacts.js";
import { EXIT_CODES, ProvenWayError } from "./errors.js";
import { ensurePrivateDirectory } from "./paths.js";

export interface RepositoryLock {
  path: string;
  release(): Promise<void>;
}

interface LockPayload {
  pid: number;
  runId: string;
  repositoryRoot: string;
  createdAt: string;
}

export async function acquireRepositoryLock(
  locksDirectory: string,
  repositoryRoot: string,
  runId: string,
): Promise<RepositoryLock> {
  await ensurePrivateDirectory(locksDirectory);
  const lockPath = path.join(locksDirectory, `${sha256(repositoryRoot)}.lock`);
  await clearStaleLock(lockPath);
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new ProvenWayError(
        `Another ProvenWay run is active for ${repositoryRoot}`,
        EXIT_CODES.awaitingUser,
        "REPOSITORY_LOCKED",
      );
    }
    throw error;
  }
  const payload: LockPayload = {
    pid: process.pid,
    runId,
    repositoryRoot,
    createdAt: new Date().toISOString(),
  };
  await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
  await handle.close();
  let released = false;
  return {
    path: lockPath,
    release: async () => {
      if (released) return;
      released = true;
      await rm(lockPath, { force: true });
    },
  };
}

export async function cancelLockedRun(
  locksDirectory: string,
  repositoryRoot: string,
  runId: string,
): Promise<boolean> {
  const lockPath = path.join(locksDirectory, `${sha256(repositoryRoot)}.lock`);
  try {
    const payload = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockPayload>;
    if (payload.runId !== runId || typeof payload.pid !== "number") return false;
    process.kill(payload.pid, "SIGTERM");
    return true;
  } catch (error) {
    if (isNodeError(error) && ["ENOENT", "ESRCH"].includes(error.code ?? "")) return false;
    throw error;
  }
}

async function clearStaleLock(lockPath: string): Promise<void> {
  try {
    const payload = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockPayload>;
    if (typeof payload.pid === "number" && isProcessAlive(payload.pid)) return;
    await rm(lockPath, { force: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    if (error instanceof SyntaxError) {
      await rm(lockPath, { force: true });
      return;
    }
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
