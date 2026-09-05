import { CodexAdapter } from "./adapters/codex.js";
import { CursorAdapter } from "./adapters/cursor.js";
import { resolveConfiguration } from "./config.js";
import { captureCommand } from "./executable.js";
import { inspectRepository } from "./git.js";
import type { RelayPaths } from "./paths.js";
import { ensureRelayPaths } from "./paths.js";
import type { RelayUi } from "./ui.js";

export interface DoctorResult {
  healthy: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export async function runDoctor(
  paths: RelayPaths,
  ui: RelayUi,
  cwd: string,
  deep: boolean,
): Promise<DoctorResult> {
  await ensureRelayPaths(paths);
  let repositoryRoot: string | undefined;
  try {
    repositoryRoot = (await inspectRepository(cwd)).root;
  } catch {
    // Doctor can run outside a repository.
  }
  const resolved = await resolveConfiguration(paths, repositoryRoot);
  const checks: DoctorResult["checks"] = [];
  const git = await captureCommand("git", ["--version"], cwd);
  checks.push({ name: "git", ok: git.exitCode === 0, detail: (git.stdout || git.stderr).trim() });
  checks.push({
    name: "configuration",
    ok: Object.values(resolved.config.roles).every((role) => role.model.trim() !== ""),
    detail: resolved.globalFile,
  });

  const codex = await new CodexAdapter(resolved.config.providers.codex.executable).probe({
    cwd,
    deep,
  });
  checks.push({
    name: "codex",
    ok:
      codex.installed &&
      codex.authenticated === true &&
      codex.supportsJsonEvents &&
      codex.supportsOutputSchema &&
      codex.permissionModes.includes("read-only") &&
      (resolved.config.policy.allow_payg || codex.authMode !== "api-key"),
    detail: providerDetail(codex),
  });

  const cursor = await new CursorAdapter(resolved.config.providers.cursor.executable).probe({
    cwd,
    deep,
  });
  checks.push({
    name: "cursor",
    ok:
      cursor.installed &&
      cursor.authenticated === true &&
      cursor.supportsJsonEvents &&
      cursor.permissionModes.includes("workspace-write") &&
      (resolved.config.policy.allow_payg || cursor.authMode !== "api-key"),
    detail: providerDetail(cursor),
  });
  checks.push({
    name: "repository",
    ok: Boolean(repositoryRoot),
    detail: repositoryRoot ?? "not inside a Git repository",
  });
  checks.push({ name: "data directory", ok: true, detail: paths.dataDir });

  for (const check of checks) {
    (check.ok ? ui.success.bind(ui) : ui.warn.bind(ui))(
      `${check.name}: ${check.ok ? "ok" : "needs attention"} — ${check.detail}`,
    );
  }
  return { healthy: checks.every((check) => check.ok), checks };
}

function providerDetail(capabilities: Awaited<ReturnType<CodexAdapter["probe"]>>): string {
  return [
    capabilities.version ?? "not installed",
    `auth=${String(capabilities.authenticated)}:${capabilities.authMode ?? "unknown"}`,
    ...capabilities.warnings,
  ]
    .filter(Boolean)
    .join(", ");
}
