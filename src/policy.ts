import { minimatch } from "minimatch";
import { EXIT_CODES, RelayError } from "./errors.js";

export const BUILTIN_FORBIDDEN_PATHS = [
  "**/.env*",
  "**/*.pem",
  "**/*.key",
  ".git",
  ".git/**",
] as const;

export const CURSOR_DENY_PERMISSIONS = [
  "Write(.cursor/cli.json)",
  "Write(.git)",
  "Write(.git/**)",
  "Read(**/.env*)",
  "Write(**/.env*)",
  "Read(**/*.pem)",
  "Write(**/*.pem)",
  "Read(**/*.key)",
  "Write(**/*.key)",
  "Shell(rm)",
  "Shell(sudo)",
  "Shell(ssh)",
  "Shell(scp)",
  "Shell(git:push*)",
  "Shell(git:clean*)",
  "Shell(git:reset*)",
  "Shell(git:commit*)",
  "WebFetch(*)",
] as const;

export function findForbiddenPaths(
  paths: readonly string[],
  patterns: readonly string[],
): string[] {
  return paths.filter((candidate) =>
    patterns.some((pattern) => minimatch(candidate, pattern, { dot: true, matchBase: false })),
  );
}

export function assertNoForbiddenPaths(
  paths: readonly string[],
  patterns: readonly string[],
): void {
  const forbidden = findForbiddenPaths(paths, patterns);
  if (forbidden.length > 0) {
    throw new RelayError(
      `Provider modified forbidden paths: ${forbidden.join(", ")}`,
      EXIT_CODES.provider,
      "FORBIDDEN_PATH_MODIFIED",
      { paths: forbidden },
    );
  }
}

export function mergeCursorDenyPermissions(
  existing: unknown,
  forbiddenPaths: readonly string[],
): Record<string, unknown> {
  const root = isRecord(existing) ? structuredClone(existing) : {};
  const permissions = isRecord(root.permissions) ? root.permissions : {};
  const existingAllow = stringArray(permissions.allow);
  const existingDeny = stringArray(permissions.deny);
  const pathDenies = forbiddenPaths.map((pattern) => `Write(${pattern})`);
  root.permissions = {
    ...permissions,
    allow: existingAllow,
    deny: [...new Set([...existingDeny, ...CURSOR_DENY_PERMISSIONS, ...pathDenies])],
  };
  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
