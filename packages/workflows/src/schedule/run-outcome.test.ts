// A warm-kept scheduled fire still settles. Native ScheduleTrigger
// definitions own one self-anchored workflow_run that must stay live
// across fires (CL-7418), so no server-side stamp ever flips it terminal
// per fire — surfaces read the fire settled through runOutcomeStatus
// past FIRE_RUNNING_WINDOW_MS instead.
import { describe, expect, test } from "bun:test";

import { FIRE_RUNNING_WINDOW_MS, runOutcomeStatus } from "./run-outcome";

const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const OLD = new Date(NOW - FIRE_RUNNING_WINDOW_MS - 1).toISOString();
const FRESH = new Date(NOW - 1_000).toISOString();

describe("warm-kept scheduled fire settling (CL-7418)", () => {
  test("a fire with no in-flight turn past the window reads completed", () => {
    expect(
      runOutcomeStatus({ createdAt: OLD, status: "running", endedAt: null, turns: [] }, NOW),
    ).toBe("completed");
  });

  test("a fire flagged with no in-flight turn past the window reads completed", () => {
    expect(
      runOutcomeStatus(
        {
          createdAt: OLD,
          status: "running",
          endedAt: null,
          hasInFlightTurn: false,
        },
        NOW,
      ),
    ).toBe("completed");
  });

  test("a fresh scheduled tick inside the window stays running", () => {
    expect(
      runOutcomeStatus({ createdAt: FRESH, status: "running", endedAt: null, turns: [] }, NOW),
    ).toBe("running");
  });

  test("a live tool loop stays running however old the fire", () => {
    expect(
      runOutcomeStatus(
        {
          createdAt: OLD,
          status: "running",
          endedAt: null,
          turns: [{ status: "running" }],
        },
        NOW,
      ),
    ).toBe("running");
  });

  test("an endedAt stamp reads completed even inside the window", () => {
    expect(
      runOutcomeStatus({ createdAt: FRESH, status: "running", endedAt: FRESH, turns: [] }, NOW),
    ).toBe("completed");
  });

  test("non-running statuses pass through untouched", () => {
    expect(
      runOutcomeStatus({ createdAt: OLD, status: "failed", endedAt: null, turns: [] }, NOW),
    ).toBe("failed");
  });
});
