import { describe, expect, it } from "bun:test";

import { computePreviousRange, deriveAgentActivity } from "./activity-overview";

describe("computePreviousRange", () => {
  it("returns the equal-length window immediately before a closed range", () => {
    const prev = computePreviousRange(
      { startDate: "2026-06-08", endDate: "2026-06-14" },
      "2026-06-25",
    );
    expect(prev).toEqual({ startDate: "2026-06-01", endDate: "2026-06-07" });
  });

  it("uses today as the end reference when the range is open-ended", () => {
    const prev = computePreviousRange(
      { startDate: "2026-06-19" },
      "2026-06-25",
    );
    // window is 7 days (19th..25th inclusive); previous is 12th..18th
    expect(prev).toEqual({ startDate: "2026-06-12", endDate: "2026-06-18" });
  });

  it("returns null for an all-time range with no start date", () => {
    expect(computePreviousRange({}, "2026-06-25")).toBeNull();
  });

  it("spans month boundaries correctly", () => {
    const prev = computePreviousRange(
      { startDate: "2026-03-01", endDate: "2026-03-31" },
      "2026-06-25",
    );
    expect(prev).toEqual({ startDate: "2026-01-29", endDate: "2026-02-28" });
  });
});

describe("deriveAgentActivity", () => {
  it("counts instances with activity as active and the remainder as idle", () => {
    const result = deriveAgentActivity(
      [{ turnCount: 5 }, { turnCount: 0 }, { turnCount: 3 }],
      10,
    );
    expect(result).toEqual({ active: 2, idle: 8 });
  });

  it("never reports negative idle when active exceeds the instance total", () => {
    const result = deriveAgentActivity([{ turnCount: 1 }, { turnCount: 2 }], 1);
    expect(result).toEqual({ active: 2, idle: 0 });
  });

  it("treats an empty breakdown as all idle", () => {
    expect(deriveAgentActivity([], 4)).toEqual({ active: 0, idle: 4 });
  });
});
