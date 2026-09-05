/* Generated from canonical JSON Schema. Do not edit. */

export interface ImplementationResult {
  schema_version: "1.0";
  task_id: string;
  base_commit: string;
  final_commit: string | null;
  provider_session_id: string | null;
  process: {
    exit_code: number | null;
    signal: string | null;
    started_at: string;
    finished_at: string;
    duration_ms: number;
  };
  claimed_commands: string[];
  claimed_paths: {
    changed: string[];
    created: string[];
    deleted: string[];
  };
  acceptance_criteria_addressed: string[];
  deviations: string[];
  unresolved_items: string[];
  relay_git: {
    diff_sha256: string;
    changed: string[];
    created: string[];
    deleted: string[];
  };
}
