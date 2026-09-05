import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { normalizeCodexEvent } from "../src/adapters/codex.js";
import { normalizeCursorEvent } from "../src/adapters/cursor.js";

describe("provider event normalization", () => {
  it("normalizes Codex fixtures and preserves unknown fields", async () => {
    const lines = (
      await readFile(new URL("./fixtures/codex/events.ndjson", import.meta.url), "utf8")
    )
      .trim()
      .split("\n");
    const events = lines.map(normalizeCodexEvent);
    expect(events.map((event) => event.type)).toEqual([
      "init",
      "tool_started",
      "unknown",
      "result",
    ]);
    expect(events[0]?.sessionId).toBe("codex-session");
    expect(events[0]?.raw).toMatchObject({ future_field: true });
  });

  it("normalizes Cursor fixtures and tolerates malformed events", async () => {
    const lines = (
      await readFile(new URL("./fixtures/cursor/events.ndjson", import.meta.url), "utf8")
    )
      .trim()
      .split("\n");
    const events = [...lines.map(normalizeCursorEvent), normalizeCursorEvent("not-json")];
    expect(events.map((event) => event.type)).toEqual([
      "init",
      "tool_started",
      "tool_completed",
      "unknown",
      "result",
      "unknown",
    ]);
    expect(events[0]?.sessionId).toBe("cursor-session");
  });
});
