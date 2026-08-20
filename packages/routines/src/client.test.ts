import { describe, expect, test } from "bun:test";
import { type } from "arktype";

import {
  Routine,
  RoutineDraft,
  routineCreatedToast,
  routineDraftApprovePath,
  routineDraftDiscardPath,
  routineDraftPath,
  routineDraftsPath,
  routinePath,
  routineRunNowPath,
  routineRunStartedToast,
  routineRunsPath,
  routineSlug,
  routinesPath,
} from "./client";

describe("routineSlug", () => {
  test("derives the URL-facing name from the display name", () => {
    expect(routineSlug("Morning brief")).toBe("morning-brief");
    expect(routineSlug("Weekly Digest — Q3!")).toBe("weekly-digest-q3");
  });

  test("empty for a name that cannot name a URL, so a caller can skip the link", () => {
    expect(routineSlug("🌅")).toBe("");
  });
});

describe("routine toast copy", () => {
  test("create carries the routine's name", () => {
    expect(routineCreatedToast("Morning brief")).toBe(
      "Routine created · Morning brief",
    );
  });

  test("run-now confirms the run has started", () => {
    expect(routineRunStartedToast("Morning brief")).toBe(
      "Run started · Morning brief",
    );
  });
});

describe("routine path builders", () => {
  test("build tenant-scoped routine paths", () => {
    expect(routinesPath("t1")).toBe("/api/tenants/t1/routines");
    expect(routinePath("t1", "r1")).toBe("/api/tenants/t1/routines/r1");
    expect(routineRunNowPath("t1", "r1")).toBe(
      "/api/tenants/t1/routines/r1/run",
    );
    expect(routineRunsPath("t1", "r1")).toBe(
      "/api/tenants/t1/routines/r1/runs",
    );
  });

  test("build tenant-scoped routine-draft paths", () => {
    expect(routineDraftsPath("t1")).toBe("/api/tenants/t1/routine-drafts");
    expect(routineDraftPath("t1", "d1")).toBe(
      "/api/tenants/t1/routine-drafts/d1",
    );
    expect(routineDraftApprovePath("t1", "d1")).toBe(
      "/api/tenants/t1/routine-drafts/d1/approve",
    );
    expect(routineDraftDiscardPath("t1", "d1")).toBe(
      "/api/tenants/t1/routine-drafts/d1/discard",
    );
  });
});

describe("wire schemas", () => {
  test("Routine parses a manual-trigger routine", () => {
    const out = Routine({
      id: "r1",
      name: "Morning brief",
      definitionId: "wfd_1",
      trigger: null,
      scope: "personal",
      input: {},
      enabled: true,
      deliveryWorkbenchId: null,
      consecutiveFailures: 0,
      deadLetteredAt: null,
      nextFireAt: null,
      lastFireAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(out instanceof type.errors).toBe(false);
  });

  test("Routine parses a response whose trigger carries an unrecognized timezone", () => {
    // A row the server already accepted at save time must still parse on
    // read even if a stricter check would reject it today — see
    // RoutineTriggerWire in ./trigger.
    const out = Routine({
      id: "r1",
      name: "Morning brief",
      definitionId: "wfd_1",
      trigger: {
        kind: "daily",
        hour: 9,
        minute: 0,
        timezone: "Mars/Olympus_Mons",
      },
      scope: "personal",
      input: {},
      enabled: true,
      deliveryWorkbenchId: null,
      consecutiveFailures: 0,
      deadLetteredAt: null,
      nextFireAt: null,
      lastFireAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(out instanceof type.errors).toBe(false);
  });

  test("RoutineDraft parses a drafted proposal", () => {
    const out = RoutineDraft({
      id: "d1",
      prompt: "Summarize every morning",
      status: "draft",
      proposedSteps: [{ title: "Summarize inbox" }],
      proposedTrigger: { kind: "daily", hour: 9, minute: 0 },
      proposedName: "Morning brief",
      definitionId: null,
      deliveryWorkbenchId: "ch_1",
      scope: "personal",
      autonomy: null,
      approvedRoutineId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(out instanceof type.errors).toBe(false);
  });
});
