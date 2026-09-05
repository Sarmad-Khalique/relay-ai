import { homedir } from "node:os";
import path from "node:path";
import { chmod, mkdir, realpath } from "node:fs/promises";

export interface ProvenWayPaths {
  configDir: string;
  configFile: string;
  dataDir: string;
  databaseFile: string;
  runsDir: string;
  worktreesDir: string;
  locksDir: string;
}

export function resolveProvenWayPaths(env: NodeJS.ProcessEnv = process.env): ProvenWayPaths {
  const configBase = env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  const dataBase = env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
  const configDir = path.join(configBase, "provenway");
  const dataDir = path.join(dataBase, "provenway");
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

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export async function ensureProvenWayPaths(paths: ProvenWayPaths): Promise<void> {
  await Promise.all([
    ensurePrivateDirectory(paths.configDir),
    ensurePrivateDirectory(paths.dataDir),
    ensurePrivateDirectory(paths.runsDir),
    ensurePrivateDirectory(paths.worktreesDir),
    ensurePrivateDirectory(paths.locksDir),
  ]);
}

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export async function assertRealPathInside(parent: string, candidateParent: string): Promise<void> {
  const [realParent, realCandidate] = await Promise.all([
    realpath(parent),
    realpath(candidateParent),
  ]);
  if (!isPathInside(realParent, realCandidate)) {
    throw new Error(`Resolved path escapes managed root: ${realCandidate}`);
  }
}
