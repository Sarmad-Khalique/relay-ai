import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CodexAdapter } from "../../src/adapters/codex.js";
import { CursorAdapter } from "../../src/adapters/cursor.js";
import { DEFAULT_CONFIG, writeGlobalConfig } from "../../src/config.js";
import { RunStore } from "../../src/store.js";
import { WorkflowEngine } from "../../src/workflow.js";
import { createGitRepository, TestUi, testPaths } from "../helpers.js";

const enabled =
  process.env.PROVENWAY_LIVE_CODEX === "1" &&
  process.env.PROVENWAY_LIVE_CURSOR === "1" &&
  Boolean(process.env.PROVENWAY_LIVE_CODEX_MODEL) &&
  Boolean(process.env.PROVENWAY_LIVE_CURSOR_MODEL);
const temporary: string[] = [];
afterAll(async () =>
  Promise.all(temporary.map((item) => rm(item, { recursive: true, force: true }))),
);

describe.skipIf(!enabled)("live provider workflow", () => {
  it("completes a tiny account-authenticated Codex/Cursor run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "provenway-live-"));
    temporary.push(root);
    const repository = await createGitRepository(root);
    const paths = testPaths(root);
    const config = structuredClone(DEFAULT_CONFIG);
    config.roles.architect.model = process.env.PROVENWAY_LIVE_CODEX_MODEL ?? "";
    config.roles.reviewer.model = process.env.PROVENWAY_LIVE_CODEX_MODEL ?? "";
    config.roles.implementer.model = process.env.PROVENWAY_LIVE_CURSOR_MODEL ?? "";
    config.workflow.repair_attempts = 0;
    await writeGlobalConfig(paths, config);
    const store = await RunStore.open(paths.databaseFile);
    try {
      const engine = new WorkflowEngine(
        paths,
        store,
        { codex: new CodexAdapter(), cursor: new CursorAdapter() },
        new TestUi(),
      );
      const outcome = await engine.execute({
        cwd: repository,
        task: "Create hello.txt containing exactly: hello from ProvenWay",
      });
      expect(outcome.run.status).toBe("accepted");
    } finally {
      store.close();
    }
  });
});
