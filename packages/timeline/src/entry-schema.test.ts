import { describe, expect, test } from "bun:test";
import { type } from "arktype";

import {
  TimelineEntrySchema,
  timelineEntryKinds,
  type TimelineEntry,
} from "./entry-schema";

describe("TimelineEntrySchema", () => {
  test("accepts a valid entry for every kind", () => {
    for (const kind of timelineEntryKinds) {
      const entry = {
        kind,
        id: "row-1",
        sourceTable: "some_table",
        timestamp: "2026-07-01T00:00:00.000Z",
        summary: "hello",
      };
      const parsed = TimelineEntrySchema(entry);
      expect(parsed).toEqual(entry as TimelineEntry);
    }
  });

  test("accepts a null summary", () => {
    const parsed = TimelineEntrySchema({
      kind: "artifact",
      id: "row-1",
      sourceTable: "artifact",
      timestamp: "2026-07-01T00:00:00.000Z",
      summary: null,
    });
    expect(parsed).toMatchObject({ summary: null });
  });

  test("rejects an unknown kind", () => {
    const out = TimelineEntrySchema({
      kind: "audit_log",
      id: "row-1",
      sourceTable: "audit_log",
      timestamp: "2026-07-01T00:00:00.000Z",
      summary: null,
    });
    expect(out instanceof type.errors).toBe(true);
  });

  test("rejects a missing id", () => {
    const out = TimelineEntrySchema({
      kind: "session",
      sourceTable: "agent_session",
      timestamp: "2026-07-01T00:00:00.000Z",
      summary: null,
    });
    expect(out instanceof type.errors).toBe(true);
  });
});
