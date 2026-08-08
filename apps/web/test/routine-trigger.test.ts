// Pure-function proof for the Routines page's cadence rendering and
// best-effort next-run estimate — no fetch, no DOM.

import { describe, expect, test } from "bun:test";
import { approximateNextRun, cadenceLabel } from "../src/routine-trigger";

describe("cadenceLabel", () => {
  test("null trigger reads as manual", () => {
    expect(cadenceLabel(null)).toBe("Manual");
  });

  test("interval trigger pluralizes correctly", () => {
    expect(cadenceLabel({ kind: "interval", unit: "minutes", every: 1 })).toBe(
      "Every minute",
    );
    expect(cadenceLabel({ kind: "interval", unit: "hours", every: 2 })).toBe(
      "Every 2 hours",
    );
  });

  test("daily trigger renders a UTC time", () => {
    expect(cadenceLabel({ kind: "daily", hour: 9, minute: 5 })).toBe(
      "Daily at 09:05 UTC",
    );
  });

  test("weekly trigger names the weekday", () => {
    expect(
      cadenceLabel({ kind: "weekly", dayOfWeek: 1, hour: 7, minute: 30 }),
    ).toBe("Weekly on Monday at 07:30 UTC");
  });

  test("cron trigger shows the raw expression", () => {
    expect(cadenceLabel({ kind: "cron", expression: "*/5 * * * *" })).toBe(
      "Cron: */5 * * * *",
    );
  });
});

describe("approximateNextRun", () => {
  test("manual and cron triggers have no closed-form estimate", () => {
    expect(approximateNextRun(null, new Date())).toBeNull();
    expect(
      approximateNextRun({ kind: "cron", expression: "* * * * *" }, new Date()),
    ).toBeNull();
  });

  test("interval adds its step to now", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const next = approximateNextRun(
      { kind: "interval", unit: "minutes", every: 15 },
      now,
    );
    expect(next?.toISOString()).toBe("2026-01-01T00:15:00.000Z");
  });

  test("daily rolls to tomorrow once today's time has passed", () => {
    const now = new Date("2026-01-01T10:00:00Z");
    const next = approximateNextRun({ kind: "daily", hour: 9, minute: 0 }, now);
    expect(next?.toISOString()).toBe("2026-01-02T09:00:00.000Z");
  });

  test("daily stays today when the time has not passed yet", () => {
    const now = new Date("2026-01-01T08:00:00Z");
    const next = approximateNextRun({ kind: "daily", hour: 9, minute: 0 }, now);
    expect(next?.toISOString()).toBe("2026-01-01T09:00:00.000Z");
  });

  test("weekly finds the next matching weekday", () => {
    // 2026-01-01 is a Thursday (day 4).
    const now = new Date("2026-01-01T00:00:00Z");
    const next = approximateNextRun(
      { kind: "weekly", dayOfWeek: 1, hour: 9, minute: 0 },
      now,
    );
    // Next Monday is 2026-01-05.
    expect(next?.toISOString()).toBe("2026-01-05T09:00:00.000Z");
  });
});
