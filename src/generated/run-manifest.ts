/* Generated from canonical JSON Schema. Do not edit. */

export interface RunManifest {
  schema_version: "1.0";
  run_id: string;
  task: string;
  status: string;
  repository_root: string;
  base_commit: string;
  final_commit: string | null;
  branch?: string;
  worktree?: string;
  created_at: string;
  updated_at: string;
  repair_count: number;
  configuration: {
    [k: string]: unknown;
  };
  providers: {
    [k: string]: unknown;
  };
  transitions: {
    from: string | null;
    to: string;
    at: string;
    detail?: string;
  }[];
  artifacts: {
    name: string;
    path: string;
    sha256: string;
    bytes: number;
    media_type: string;
    stage: string;
  }[];
}
