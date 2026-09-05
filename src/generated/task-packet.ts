/* Generated from canonical JSON Schema. Do not edit. */

export interface TaskPacket {
  schema_version: "1.0";
  task_id: string;
  goal: string;
  change_required: boolean;
  repo_facts: {
    base_commit: string;
    default_branch: string;
    languages: string[];
  };
  constraints: string[];
  acceptance_criteria: {
    id: string;
    text: string;
    verification: "test" | "inspection" | "manual";
  }[];
  steps: {
    id: string;
    description: string;
    likely_paths: string[];
  }[];
  required_tests: string[];
  forbidden_paths: string[];
  open_questions: {
    id: string;
    text: string;
    blocking: boolean;
  }[];
  risk_notes: string[];
}
