import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProcess } from "../src/subprocess.js";

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(temporary.splice(0).map((item) => rm(item, { recursive: true, force: true }))),
);

describe("safe subprocess runner", () => {
  it("captures output without a shell and redacts tokens before persistence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "relay-process-"));
    temporary.push(root);
    const stdoutPath = path.join(root, "stdout.log");
    const result = await runProcess({
      executable: process.execPath,
      args: ["-e", "console.log('sk-abcdefghijklmnopqrstuvwxyz')"],
      cwd: root,
      stdoutPath,
      stderrPath: path.join(root, "stderr.log"),
      timeoutMs: 5_000,
      maxLogBytes: 1024,
    });
    expect(result.exitCode).toBe(0);
    expect(await readFile(stdoutPath, "utf8")).toContain("[REDACTED]");
    expect(await readFile(stdoutPath, "utf8")).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("terminates a timed-out process group", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "relay-process-"));
    temporary.push(root);
    const result = await runProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      stdoutPath: path.join(root, "stdout.log"),
      stderrPath: path.join(root, "stderr.log"),
      timeoutMs: 50,
      maxLogBytes: 1024,
    });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGTERM");
  });
});
