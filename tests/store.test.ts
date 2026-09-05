import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "../src/store.js";

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(temporary.splice(0).map((item) => rm(item, { recursive: true, force: true }))),
);

describe("run store", () => {
  it("persists append-only transitions and run metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "provenway-store-"));
    temporary.push(root);
    const store = await RunStore.open(path.join(root, "provenway.sqlite"));
    try {
      store.createRun({
        runId: "01TEST",
        task: "test",
        repositoryRoot: "/tmp/repo",
        baseCommit: "abcdef1",
        configuration: { version: 1 },
      });
      store.transition("01TEST", "preparing", "probe");
      store.transition("01TEST", "planning", "plan");
      store.setLocations("01TEST", "provenway/test", "/tmp/worktree");
      store.setRepairCount("01TEST", 1);
      expect(store.requireRun("01TEST")).toMatchObject({
        status: "planning",
        branch: "provenway/test",
        repairCount: 1,
      });
      expect(store.transitions("01TEST").map((item) => item.to)).toEqual([
        "created",
        "preparing",
        "planning",
      ]);
      expect(store.findActiveByRepository("/tmp/repo")).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
