/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import type { TimelineEntry } from "@workbench/client";
import {
  GRANT_EFFECT_LABEL,
  entityLinkForEntry,
  formatElapsedBetween,
  grantEffect,
} from "./trace-links";

function entry(
  partial: Partial<TimelineEntry> & { kind: TimelineEntry["kind"] },
): TimelineEntry {
  return {
    id: "x",
    sourceTable: "t",
    timestamp: "2026-07-01T00:00:00.000Z",
    summary: null,
    ...partial,
  } as TimelineEntry;
}

describe("entityLinkForEntry", () => {
  it("links a workflow_run moment to its run trace, id-encoded", () => {
    const link = entityLinkForEntry(
      entry({ kind: "workflow_run", id: "run/1" }),
    );
    expect(link).toEqual({
      to: "/insights/trace/run%2F1",
      label: "Open run trace",
    });
  });

  it("links an artifact moment to its artifact detail page", () => {
    const link = entityLinkForEntry(entry({ kind: "artifact", id: "art_9" }));
    expect(link).toEqual({ to: "/artifacts/art_9", label: "Open artifact" });
  });

  it("does NOT link an artifact_version (its id is a version id, not the artifact route id)", () => {
    // Honest: we have no artifact id on the version entry, so we never guess a route.
    expect(
      entityLinkForEntry(entry({ kind: "artifact_version", id: "ver_1" })),
    ).toBeNull();
  });

  it("returns null for kinds with no dedicated trace destination today", () => {
    for (const kind of [
      "session",
      "message",
      "inference_turn",
      "tool_call",
      "grant",
      "credential",
      "upload",
      "memory",
      "approval",
      "output_feedback",
    ] as const) {
      expect(entityLinkForEntry(entry({ kind }))).toBeNull();
    }
  });
});

describe("grantEffect", () => {
  it("maps the trailing effect token of a grant summary to a plain-language effect", () => {
    expect(
      grantEffect(entry({ kind: "grant", summary: "tool:x__y invoke allow" })),
    ).toBe("allowed");
    expect(
      grantEffect(entry({ kind: "grant", summary: "tool:x__y invoke deny" })),
    ).toBe("blocked");
    expect(
      grantEffect(entry({ kind: "grant", summary: "tool:x__y invoke ask" })),
    ).toBe("needs-approval");
  });

  it("is unknown for an unrecognized effect or a null summary", () => {
    expect(grantEffect(entry({ kind: "grant", summary: null }))).toBe(
      "unknown",
    );
    expect(grantEffect(entry({ kind: "grant", summary: "weird" }))).toBe(
      "unknown",
    );
  });

  it("is unknown for a non-grant entry (never inferred)", () => {
    expect(
      grantEffect(entry({ kind: "tool_call", summary: "foo allow" })),
    ).toBe("unknown");
  });

  it("has a label for every effect", () => {
    expect(GRANT_EFFECT_LABEL.allowed).toBe("Allowed");
    expect(GRANT_EFFECT_LABEL.blocked).toBe("Blocked");
    expect(GRANT_EFFECT_LABEL["needs-approval"]).toBe("Needs approval");
    expect(GRANT_EFFECT_LABEL.unknown).toBe("Effect not recorded");
  });
});

describe("formatElapsedBetween", () => {
  it("returns null when either boundary is absent", () => {
    expect(
      formatElapsedBetween(undefined, "2026-07-01T00:00:00.000Z"),
    ).toBeNull();
    expect(
      formatElapsedBetween("2026-07-01T00:00:00.000Z", undefined),
    ).toBeNull();
  });

  it("returns null for an inverted (negative) span rather than inventing one", () => {
    expect(
      formatElapsedBetween(
        "2026-07-01T00:00:01.000Z",
        "2026-07-01T00:00:00.000Z",
      ),
    ).toBeNull();
  });

  it("formats sub-second, second, and minute spans", () => {
    expect(
      formatElapsedBetween(
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:00.400Z",
      ),
    ).toBe("400ms");
    expect(
      formatElapsedBetween(
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:05.000Z",
      ),
    ).toBe("5.0s");
    expect(
      formatElapsedBetween(
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:02:05.000Z",
      ),
    ).toBe("2m 5s");
  });
});
