import { describe, expect, it } from "vitest";
import { parseJsonOutput, validateOrThrow, validators } from "../src/schemas.js";

const packet = {
  schema_version: "1.0",
  task_id: "01TEST",
  goal: "Add a feature",
  change_required: true,
  repo_facts: { base_commit: "abcdef123456", default_branch: "main", languages: ["typescript"] },
  constraints: [],
  acceptance_criteria: [{ id: "AC-1", text: "It works", verification: "test" }],
  steps: [{ id: "S-1", description: "Implement it", likely_paths: ["src/**"] }],
  required_tests: ["unit tests"],
  forbidden_paths: ["**/.env*"],
  open_questions: [],
  risk_notes: [],
};

describe("canonical schemas", () => {
  it("validates and parses fenced TaskPacket JSON", () => {
    expect(validateOrThrow(validators.taskPacket, packet, "packet").goal).toBe("Add a feature");
    expect(
      parseJsonOutput(
        validators.taskPacket,
        `\`\`\`json\n${JSON.stringify(packet)}\n\`\`\``,
        "packet",
      ),
    ).toMatchObject({ task_id: "01TEST" });
  });

  it("rejects unknown fields and malformed JSON", () => {
    expect(() =>
      validateOrThrow(validators.taskPacket, { ...packet, surprise: true }, "packet"),
    ).toThrow("Invalid packet");
    expect(() => parseJsonOutput(validators.taskPacket, "not-json", "packet")).toThrow(
      "Invalid JSON",
    );
  });
});
