import { EXIT_CODES, RelayError } from "./errors.js";

export const RUN_STATUSES = [
  "created",
  "preparing",
  "planning",
  "awaiting_confirmation",
  "creating_worktree",
  "implementing",
  "verifying",
  "reviewing",
  "repairing",
  "finalizing",
  "accepted",
  "accepted_no_change",
  "planned",
  "blocked_user",
  "blocked_auth",
  "blocked_quota",
  "interrupted",
  "cancelled",
  "failed_config",
  "failed_provider",
  "failed_policy",
  "failed_verification",
  "changes_requested",
  "implemented_unreviewed",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_STATUSES = new Set<RunStatus>([
  "accepted",
  "accepted_no_change",
  "planned",
  "cancelled",
  "failed_config",
  "failed_provider",
  "failed_policy",
  "failed_verification",
  "changes_requested",
  "implemented_unreviewed",
]);

const transitions: Record<RunStatus, readonly RunStatus[]> = {
  created: ["preparing", "cancelled", "failed_config"],
  preparing: ["planning", "blocked_auth", "failed_config", "failed_provider", "cancelled"],
  planning: [
    "awaiting_confirmation",
    "accepted_no_change",
    "planned",
    "blocked_user",
    "blocked_auth",
    "blocked_quota",
    "failed_provider",
    "cancelled",
    "interrupted",
  ],
  awaiting_confirmation: ["creating_worktree", "blocked_user", "cancelled", "failed_config"],
  creating_worktree: [
    "implementing",
    "failed_provider",
    "failed_policy",
    "cancelled",
    "interrupted",
  ],
  implementing: [
    "verifying",
    "blocked_auth",
    "blocked_quota",
    "failed_provider",
    "failed_policy",
    "cancelled",
    "interrupted",
  ],
  verifying: ["reviewing", "failed_policy", "failed_verification", "cancelled", "interrupted"],
  reviewing: [
    "repairing",
    "finalizing",
    "failed_verification",
    "changes_requested",
    "blocked_auth",
    "blocked_quota",
    "implemented_unreviewed",
    "failed_provider",
    "cancelled",
    "interrupted",
  ],
  repairing: [
    "verifying",
    "blocked_auth",
    "blocked_quota",
    "failed_provider",
    "failed_policy",
    "changes_requested",
    "cancelled",
    "interrupted",
  ],
  finalizing: ["accepted", "failed_provider", "failed_policy", "interrupted"],
  blocked_user: ["preparing", "planning", "awaiting_confirmation", "verifying", "cancelled"],
  blocked_auth: [
    "preparing",
    "planning",
    "implementing",
    "verifying",
    "reviewing",
    "repairing",
    "cancelled",
  ],
  blocked_quota: ["planning", "implementing", "verifying", "reviewing", "repairing", "cancelled"],
  interrupted: ["preparing", "planning", "verifying", "reviewing", "repairing", "cancelled"],
  accepted: [],
  accepted_no_change: [],
  planned: [],
  cancelled: [],
  failed_config: [],
  failed_provider: [],
  failed_policy: [],
  failed_verification: [],
  changes_requested: [],
  implemented_unreviewed: ["verifying", "reviewing", "cancelled"],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) {
    throw new RelayError(
      `Invalid run transition: ${from} -> ${to}`,
      EXIT_CODES.invalidInput,
      "INVALID_TRANSITION",
    );
  }
}

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
