import { describe, expect, test } from "bun:test";
import type { TimelineEntry } from "@workbench/client";
import { KIND_META, timelineEntryTone } from "./timeline-kinds";

function entry(over: Partial<TimelineEntry>): TimelineEntry {
  return {
    kind: "grant",
    id: "id",
    sourceTable: "grant",
    timestamp: "2026-07-03T12:00:00.000Z",
    summary: null,
    ...over,
  } as TimelineEntry;
}

describe("timelineEntryTone", () => {
  test("an allowed grant is positive, not the alarming red danger", () => {
    const tone = timelineEntryTone(
      entry({ kind: "grant", summary: "tool:exa__search invoke allow" }),
    );
    expect(tone).toBe("positive");
    // Regression: it must not read as danger.
    expect(tone).not.toBe("danger");
  });

  test("a denied grant is danger", () => {
    expect(
      timelineEntryTone(
        entry({ kind: "grant", summary: "tool:exa__search invoke deny" }),
      ),
    ).toBe("danger");
  });

  test("an ask/other grant effect stays neutral", () => {
    expect(
      timelineEntryTone(
        entry({ kind: "grant", summary: "tool:exa__search invoke ask" }),
      ),
    ).toBe("neutral");
  });

  test("workflow_run and upload are neutral, never the orange action tone", () => {
    expect(KIND_META.workflow_run.tone).toBe("neutral");
    expect(KIND_META.upload.tone).toBe("neutral");
  });

  test("a non-grant kind uses its static KIND_META tone", () => {
    const artifact = entry({ kind: "artifact", summary: "made a thing" });
    expect(timelineEntryTone(artifact)).toBe(KIND_META.artifact.tone);
  });
});
