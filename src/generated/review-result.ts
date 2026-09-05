/* Generated from canonical JSON Schema. Do not edit. */

export interface ReviewResult {
  schema_version: "1.0";
  task_id: string;
  verdict: "accepted" | "changes_requested";
  summary: string;
  findings: {
    id: string;
    severity: "blocking" | "advisory";
    path?: string;
    line?: number;
    title: string;
    evidence: string;
    required_change: string;
  }[];
}
