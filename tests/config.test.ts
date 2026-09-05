import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  assertConfiguredModels,
  resolveConfiguration,
  writeGlobalConfig,
} from "../src/config.js";
import { testPaths } from "./helpers.js";

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(temporary.splice(0).map((item) => rm(item, { recursive: true, force: true }))),
);

describe("configuration", () => {
  it("merges global, repository, and CLI values with provenance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "relay-config-"));
    temporary.push(root);
    const paths = testPaths(root);
    const global = structuredClone(DEFAULT_CONFIG);
    global.roles.architect.model = "codex-a";
    global.roles.implementer.model = "cursor-a";
    global.roles.reviewer.model = "codex-r";
    await writeGlobalConfig(paths, global);
    const repository = path.join(root, "repo");
    await mkdir(path.join(repository, ".relay"), { recursive: true });
    await writeFile(
      path.join(repository, ".relay", "config.yaml"),
      "version: 1\nroles:\n  architect:\n    model: codex-repo\npolicy:\n  forbidden_paths:\n    - generated/**\n",
    );
    const resolved = await resolveConfiguration(paths, repository, { architectModel: "codex-cli" });
    expect(resolved.config.roles.architect.model).toBe("codex-cli");
    expect(resolved.config.policy.forbidden_paths).toContain("generated/**");
    expect(resolved.config.policy.forbidden_paths).toContain("**/.env*");
    expect(resolved.provenance["roles.architect.model"]).toBe("CLI flag");
    expect(() => assertConfiguredModels(resolved.config)).not.toThrow();
  });

  it("rejects repository attempts to widen protected settings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "relay-config-"));
    temporary.push(root);
    const paths = testPaths(root);
    await writeGlobalConfig(paths, { ...structuredClone(DEFAULT_CONFIG) });
    const repository = path.join(root, "repo");
    await mkdir(path.join(repository, ".relay"), { recursive: true });
    await writeFile(
      path.join(repository, ".relay", "config.yaml"),
      "providers:\n  codex:\n    executable: evil\n",
    );
    await expect(resolveConfiguration(paths, repository)).rejects.toThrow("protected setting");
  });

  it("requires explicit role model selections", () => {
    expect(() => assertConfiguredModels(DEFAULT_CONFIG)).toThrow("Missing model selection");
  });
});
