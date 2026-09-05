import { describe, expect, it } from "vitest";
import {
  assertNoForbiddenPaths,
  findForbiddenPaths,
  mergeCursorDenyPermissions,
} from "../src/policy.js";
import { assertTransition, canTransition, isTerminal } from "../src/state-machine.js";

describe("state machine", () => {
  it("permits the happy path and rejects impossible transitions", () => {
    expect(canTransition("created", "preparing")).toBe(true);
    expect(canTransition("planning", "awaiting_confirmation")).toBe(true);
    expect(canTransition("reviewing", "finalizing")).toBe(true);
    expect(canTransition("accepted", "planning")).toBe(false);
    expect(() => assertTransition("accepted", "planning")).toThrow("Invalid run transition");
  });

  it("identifies terminal and resumable statuses", () => {
    expect(isTerminal("accepted")).toBe(true);
    expect(isTerminal("planned")).toBe(true);
    expect(isTerminal("blocked_user")).toBe(false);
    expect(isTerminal("interrupted")).toBe(false);
  });
});

describe("policy", () => {
  it("matches dotfiles and key material", () => {
    expect(
      findForbiddenPaths([".env", "src/a.ts", "secrets/server.pem"], ["**/.env*", "**/*.pem"]),
    ).toEqual([".env", "secrets/server.pem"]);
    expect(() => assertNoForbiddenPaths(["private.key"], ["**/*.key"])).toThrow(
      "Provider modified forbidden paths",
    );
    expect(() => assertNoForbiddenPaths(["src/a.ts"], ["**/*.key"])).not.toThrow();
  });

  it("preserves permissions while adding immutable deny rules", () => {
    const merged = mergeCursorDenyPermissions(
      { permissions: { allow: ["Read(src/**)"], deny: ["Shell(custom)"] }, theme: "dark" },
      [".github/workflows/release.yml"],
    );
    expect(merged.theme).toBe("dark");
    expect(merged.permissions).toMatchObject({ allow: ["Read(src/**)"] });
    const permissions = merged.permissions as { deny: string[] };
    expect(permissions.deny).toContain("Shell(custom)");
    expect(permissions.deny).toContain("Shell(git:push*)");
    expect(permissions.deny).toContain("Write(.github/workflows/release.yml)");
  });

  it("handles malformed existing permission input", () => {
    const merged = mergeCursorDenyPermissions("bad", []);
    expect((merged.permissions as { deny: string[] }).deny.length).toBeGreaterThan(5);
  });
});
