import { describe, expect, test } from "bun:test";
import type { TimelineEntry } from "@workbench/client";
import {
  describeActivityEntry,
  groupActivityIntoTurns,
  humanizeToken,
  parseToolResource,
} from "./activity-naming";

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

describe("humanizeToken", () => {
  test("splits __, _ and - into sentence case", () => {
    expect(humanizeToken("workflow_start")).toBe("Workflow start");
    expect(humanizeToken("workflows__workflow_start")).toBe(
      "Workflows workflow start",
    );
    expect(humanizeToken("activity-principal")).toBe("Activity principal");
  });
});

describe("parseToolResource", () => {
  test("splits factory and name", () => {
    expect(parseToolResource("tool:workflows__workflow_start")).toEqual({
      factory: "workflows",
      name: "workflow_start",
    });
  });
  test("returns null for a non-tool resource", () => {
    expect(parseToolResource("activity:principal")).toBeNull();
  });
});

describe("describeActivityEntry", () => {
  test("names the ACTION a tool grant allowed, not GRANT", () => {
    const d = describeActivityEntry(
      entry({
        kind: "grant",
        summary: "tool:workflows__workflow_start invoke allow",
      }),
    );
    expect(d.headline).toBe("Allowed: Workflow start");
    expect(d.detail).toBe("Workflows tool");
  });

  test("a denied grant reads as blocked", () => {
    const d = describeActivityEntry(
      entry({ kind: "grant", summary: "tool:exa__search invoke deny" }),
    );
    expect(d.headline).toBe("Blocked: Search");
  });

  test("an ask grant reads as needs-approval, never Blocked or Allowed", () => {
    const d = describeActivityEntry(
      entry({ kind: "grant", summary: "tool:exa__search invoke ask" }),
    );
    expect(d.headline).toBe("Needs approval: Search");
    expect(d.headline).not.toContain("Blocked");
    expect(d.headline).not.toContain("Allowed");
  });

  test("an unknown/unrecorded effect is neutral, never denied", () => {
    const d = describeActivityEntry(
      entry({ kind: "grant", summary: "tool:exa__search invoke" }),
    );
    expect(d.headline).toBe("Permission checked: Search");
    expect(d.headline).not.toContain("Blocked");
  });

  test("non-tool grant humanizes the resource", () => {
    const d = describeActivityEntry(
      entry({ kind: "grant", summary: "activity:principal read allow" }),
    );
    expect(d.headline).toBe("Allowed: Activity principal");
  });

  test("tool_call reads as what ran", () => {
    const d = describeActivityEntry(
      entry({
        kind: "tool_call",
        sourceTable: "analytics_event",
        summary: "granola_search",
      }),
    );
    expect(d.headline).toBe("Ran Granola search");
  });

  test("other kinds keep their label and raw summary", () => {
    const d = describeActivityEntry(
      entry({
        kind: "workflow_run",
        sourceTable: "workflow_run_record",
        summary: "last30days run",
      }),
    );
    expect(d.headline).toBe("Workflow run");
    expect(d.detail).toBe("last30days run");
  });
});

describe("groupActivityIntoTurns", () => {
  test("clusters time-adjacent rows and anchors the headline on the salient action", () => {
    const entries: TimelineEntry[] = [
      entry({
        kind: "workflow_run",
        id: "r1",
        sourceTable: "workflow_run_record",
        summary: "run",
        timestamp: "2026-07-03T12:00:10.000Z",
      }),
      entry({
        kind: "grant",
        id: "g1",
        summary: "tool:workflows__workflow_start invoke allow",
        timestamp: "2026-07-03T12:00:05.000Z",
      }),
      entry({
        kind: "grant",
        id: "g2",
        summary: "tool:exa__search invoke allow",
        timestamp: "2026-07-03T12:00:00.000Z",
      }),
      // a much later, separate burst
      entry({
        kind: "message",
        id: "m1",
        sourceTable: "message",
        summary: "hi",
        timestamp: "2026-07-03T10:00:00.000Z",
      }),
    ];
    const turns = groupActivityIntoTurns(entries, 60_000);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.entries).toHaveLength(3);
    expect(turns[0]?.headline).toBe("Workflow run");
    expect(turns[0]?.counts["grant"]).toBe(2);
    expect(turns[1]?.entries).toHaveLength(1);
    expect(turns[1]?.headline).toBe("Message");
  });

  test("empty input yields no turns", () => {
    expect(groupActivityIntoTurns([])).toEqual([]);
  });

  test("a single tight burst is one turn", () => {
    const entries: TimelineEntry[] = [
      entry({
        kind: "grant",
        id: "g1",
        timestamp: "2026-07-03T12:00:02.000Z",
        summary: "tool:a__b invoke allow",
      }),
      entry({
        kind: "grant",
        id: "g2",
        timestamp: "2026-07-03T12:00:01.000Z",
        summary: "tool:a__c invoke allow",
      }),
    ];
    expect(groupActivityIntoTurns(entries, 60_000)).toHaveLength(1);
  });
});
