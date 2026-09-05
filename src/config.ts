import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { BUILTIN_FORBIDDEN_PATHS } from "./policy.js";
import { ensurePrivateDirectory, type ProvenWayPaths } from "./paths.js";
import { EXIT_CODES, ProvenWayError } from "./errors.js";

const verificationCommandSchema = z.object({
  name: z.string().min(1),
  argv: z.array(z.string()).min(1),
  timeout_seconds: z.number().int().positive().default(900),
  required: z.boolean().default(true),
});

const roleSchema = z.object({
  adapter: z.enum(["codex", "cursor"]),
  model: z.string(),
  reasoning: z.enum(["low", "medium", "high"]).optional(),
});

export const provenwayConfigSchema = z.object({
  version: z.literal(1),
  providers: z.object({
    codex: z.object({ executable: z.string().min(1) }),
    cursor: z.object({ executable: z.string().min(1) }),
  }),
  roles: z.object({
    architect: roleSchema,
    implementer: roleSchema,
    reviewer: roleSchema,
  }),
  workflow: z.object({
    repair_attempts: z.number().int().min(0).max(2),
    require_clean_worktree: z.boolean(),
    keep_worktree: z.enum(["always", "on_failure", "never"]),
    provider_timeout_seconds: z.number().int().positive(),
    max_event_bytes: z.number().int().positive(),
    max_log_bytes: z.number().int().positive(),
  }),
  verification: z.object({
    discover: z.boolean(),
    commands: z.array(verificationCommandSchema),
  }),
  policy: z.object({
    allow_payg: z.boolean(),
    network: z.enum(["deny"]),
    forbidden_paths: z.array(z.string().min(1)),
  }),
});

export type ProvenWayConfig = z.infer<typeof provenwayConfigSchema>;
export type VerificationCommand = z.infer<typeof verificationCommandSchema>;

export interface ConfigOverrides {
  architectModel?: string;
  implementerModel?: string;
  reviewerModel?: string;
  repairAttempts?: number;
  keepWorktree?: "always" | "on_failure" | "never";
}

export interface ResolvedConfig {
  config: ProvenWayConfig;
  provenance: Record<string, string>;
  globalFile: string;
  repositoryFile?: string;
}

export const DEFAULT_CONFIG: ProvenWayConfig = {
  version: 1,
  providers: {
    codex: { executable: "codex" },
    cursor: { executable: "auto" },
  },
  roles: {
    architect: { adapter: "codex", model: "", reasoning: "high" },
    implementer: { adapter: "cursor", model: "" },
    reviewer: { adapter: "codex", model: "", reasoning: "high" },
  },
  workflow: {
    repair_attempts: 2,
    require_clean_worktree: true,
    keep_worktree: "on_failure",
    provider_timeout_seconds: 1_800,
    max_event_bytes: 1_048_576,
    max_log_bytes: 104_857_600,
  },
  verification: {
    discover: true,
    commands: [],
  },
  policy: {
    allow_payg: false,
    network: "deny",
    forbidden_paths: [...BUILTIN_FORBIDDEN_PATHS],
  },
};

export async function resolveConfiguration(
  paths: ProvenWayPaths,
  repositoryRoot?: string,
  overrides: ConfigOverrides = {},
): Promise<ResolvedConfig> {
  const provenance: Record<string, string> = {};
  recordProvenance(DEFAULT_CONFIG, "built-in", provenance);

  let merged: unknown = structuredClone(DEFAULT_CONFIG);
  const globalLayer = await readYamlIfPresent(paths.configFile);
  if (globalLayer) {
    merged = deepMerge(merged, globalLayer);
    recordProvenance(globalLayer, paths.configFile, provenance);
  }
  const globalConfig = parseConfig(merged, "global configuration");

  let repositoryFile: string | undefined;
  if (repositoryRoot) {
    repositoryFile = path.join(repositoryRoot, ".provenway", "config.yaml");
    const repositoryLayer = await readYamlIfPresent(repositoryFile);
    if (repositoryLayer) {
      validateRepositoryLayer(repositoryLayer, globalConfig);
      merged = mergeRepositoryLayer(merged, repositoryLayer);
      recordProvenance(repositoryLayer, repositoryFile, provenance);
    }
  }

  const overrideLayer = overridesToLayer(overrides);
  merged = deepMerge(merged, overrideLayer);
  recordProvenance(overrideLayer, "CLI flag", provenance);
  const config = parseConfig(merged, "resolved configuration");
  config.policy.forbidden_paths = [...new Set(config.policy.forbidden_paths)];

  return {
    config,
    provenance,
    globalFile: paths.configFile,
    ...(repositoryFile ? { repositoryFile } : {}),
  };
}

export function assertConfiguredModels(config: ProvenWayConfig): void {
  const missing = Object.entries(config.roles)
    .filter(([, role]) => role.model.trim() === "")
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new ProvenWayError(
      `Missing model selection for roles: ${missing.join(", ")}. Run provenway init.`,
      EXIT_CODES.invalidInput,
      "MODELS_NOT_CONFIGURED",
    );
  }
}

export async function writeGlobalConfig(
  paths: ProvenWayPaths,
  config: ProvenWayConfig,
): Promise<void> {
  await ensurePrivateDirectory(paths.configDir);
  const serialized = YAML.stringify(config, { lineWidth: 100 });
  await writeFile(paths.configFile, serialized, { mode: 0o600 });
  await chmod(paths.configFile, 0o600);
}

async function readYamlIfPresent(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = YAML.parse(await readFile(file, "utf8"));
    if (!isRecord(parsed)) {
      throw new ProvenWayError(
        `Configuration must be a YAML object: ${file}`,
        EXIT_CODES.invalidInput,
        "INVALID_CONFIG",
      );
    }
    return parsed;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function parseConfig(value: unknown, label: string): ProvenWayConfig {
  const result = provenwayConfigSchema.safeParse(value);
  if (!result.success) {
    throw new ProvenWayError(
      `Invalid ${label}: ${z.prettifyError(result.error)}`,
      EXIT_CODES.invalidInput,
      "INVALID_CONFIG",
      result.error.issues,
    );
  }
  return result.data;
}

function validateRepositoryLayer(layer: Record<string, unknown>, base: ProvenWayConfig): void {
  const allowedTopLevel = new Set(["version", "roles", "workflow", "verification", "policy"]);
  for (const key of Object.keys(layer)) {
    if (!allowedTopLevel.has(key)) invalidRepoSetting(key);
  }
  if (layer.providers !== undefined) invalidRepoSetting("providers");

  if (isRecord(layer.roles)) {
    for (const [role, value] of Object.entries(layer.roles)) {
      if (!isRecord(value)) invalidRepoSetting(`roles.${role}`);
      for (const key of Object.keys(value)) {
        if (key !== "model") invalidRepoSetting(`roles.${role}.${key}`);
      }
    }
  }

  if (isRecord(layer.workflow)) {
    const allowed = new Set([
      "repair_attempts",
      "require_clean_worktree",
      "provider_timeout_seconds",
      "max_event_bytes",
      "max_log_bytes",
    ]);
    for (const key of Object.keys(layer.workflow)) {
      if (!allowed.has(key)) invalidRepoSetting(`workflow.${key}`);
    }
    const repairAttempts = layer.workflow.repair_attempts;
    if (typeof repairAttempts === "number" && repairAttempts > base.workflow.repair_attempts) {
      invalidRepoSetting("workflow.repair_attempts");
    }
    if (layer.workflow.require_clean_worktree === false && base.workflow.require_clean_worktree) {
      invalidRepoSetting("workflow.require_clean_worktree");
    }
    for (const key of ["provider_timeout_seconds", "max_event_bytes", "max_log_bytes"] as const) {
      const candidate = layer.workflow[key];
      if (typeof candidate === "number" && candidate > base.workflow[key]) {
        invalidRepoSetting(`workflow.${key}`);
      }
    }
  }

  if (isRecord(layer.policy)) {
    for (const key of Object.keys(layer.policy)) {
      if (key !== "forbidden_paths") invalidRepoSetting(`policy.${key}`);
    }
  }

  if (isRecord(layer.verification)) {
    for (const key of Object.keys(layer.verification)) {
      if (key !== "discover" && key !== "commands") invalidRepoSetting(`verification.${key}`);
    }
    if (layer.verification.discover === true && !base.verification.discover) {
      invalidRepoSetting("verification.discover");
    }
  }
}

function mergeRepositoryLayer(base: unknown, layer: Record<string, unknown>): unknown {
  const merged = deepMerge(base, layer);
  if (!isRecord(merged) || !isRecord(merged.policy) || !isRecord(base)) return merged;
  const basePolicy = isRecord(base.policy) ? base.policy : {};
  const repoPolicy = isRecord(layer.policy) ? layer.policy : {};
  merged.policy.forbidden_paths = [
    ...stringArray(basePolicy.forbidden_paths),
    ...stringArray(repoPolicy.forbidden_paths),
  ];
  const baseVerification = isRecord(base.verification) ? base.verification : {};
  const repoVerification = isRecord(layer.verification) ? layer.verification : {};
  if (isRecord(merged.verification)) {
    merged.verification.commands = [
      ...arrayValue(baseVerification.commands),
      ...arrayValue(repoVerification.commands),
    ];
  }
  return merged;
}

function invalidRepoSetting(key: string): never {
  throw new ProvenWayError(
    `Repository configuration may not widen or replace protected setting: ${key}`,
    EXIT_CODES.invalidInput,
    "UNTRUSTED_REPOSITORY_CONFIG",
  );
}

function overridesToLayer(overrides: ConfigOverrides): Record<string, unknown> {
  const roles: Record<string, unknown> = {};
  if (overrides.architectModel !== undefined) roles.architect = { model: overrides.architectModel };
  if (overrides.implementerModel !== undefined)
    roles.implementer = { model: overrides.implementerModel };
  if (overrides.reviewerModel !== undefined) roles.reviewer = { model: overrides.reviewerModel };
  const workflow: Record<string, unknown> = {};
  if (overrides.repairAttempts !== undefined) workflow.repair_attempts = overrides.repairAttempts;
  if (overrides.keepWorktree !== undefined) workflow.keep_worktree = overrides.keepWorktree;
  return {
    ...(Object.keys(roles).length > 0 ? { roles } : {}),
    ...(Object.keys(workflow).length > 0 ? { workflow } : {}),
  };
}

function deepMerge(base: unknown, overlay: unknown): unknown {
  if (!isRecord(base) || !isRecord(overlay)) return structuredClone(overlay);
  const result: Record<string, unknown> = structuredClone(base);
  for (const [key, value] of Object.entries(overlay)) {
    result[key] = key in result ? deepMerge(result[key], value) : structuredClone(value);
  }
  return result;
}

function recordProvenance(
  value: unknown,
  source: string,
  target: Record<string, string>,
  prefix = "",
): void {
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (isRecord(child)) recordProvenance(child, source, target, full);
    else target[full] = source;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
