import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  codexCompatibleSchema,
  codexErrorFromEvents,
  normalizeCodexEvent,
} from "../src/adapters/codex.js";
import { normalizeCursorEvent, parseCursorModels } from "../src/adapters/cursor.js";

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

  it("extracts nested errors from Codex JSONL failure events", () => {
    const event = normalizeCodexEvent(
      JSON.stringify({
        type: "turn.failed",
        error: {
          message: JSON.stringify({
            error: { message: "Invalid structured output schema" },
            status: 400,
          }),
        },
      }),
    );
    expect(codexErrorFromEvents([event])).toBe("Invalid structured output schema");
  });

  it("removes JSON Schema keywords rejected by Codex while retaining canonical constraints", () => {
    expect(
      codexCompatibleSchema({
        type: "object",
        properties: {
          values: { type: "array", uniqueItems: true, items: { type: "string" } },
        },
      }),
    ).toEqual({
      type: "object",
      properties: { values: { type: "array", items: { type: "string" } } },
    });
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

  it("extracts Cursor model IDs without their display labels", () => {
    expect(
      parseCursorModels(`Available models

auto - Auto (default)
gpt-5.6-sol-high - GPT-5.6 Sol 1M High
composer-2.5 - Composer 2.5`),
    ).toEqual(["auto", "gpt-5.6-sol-high", "composer-2.5"]);
  });
});
