/* Generated from canonical JSON Schema. Do not edit. */

export interface VerificationResult {
  schema_version: "1.0";
  task_id: string;
  passed: boolean;
  commands: {
    name: string;
    /**
     * @minItems 1
     */
    argv: [string, ...string[]];
    required: boolean;
    started_at: string;
    finished_at: string;
    duration_ms: number;
    exit_code: number | null;
    signal: string | null;
    timed_out: boolean;
    cancelled: boolean;
    stdout_sha256: string;
    stderr_sha256: string;
  }[];
}
