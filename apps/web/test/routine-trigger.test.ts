// Pure-function proof for the Routines page's cadence rendering and
// best-effort next-run estimate — no fetch, no DOM.

import { describe, expect, test } from "bun:test";
import { approximateNextRun, cadenceLabel } from "../src/routine-trigger";

describe("cadenceLabel", () => {
  // The wording itself is `@corbits/routines/trigger`'s
  // `routineCadenceLabel`, covered there — this only proves the app
  // re-exports it under its established name.
  test("re-exports routineCadenceLabel", () => {
    expect(cadenceLabel(null)).toBe("Manual");
    expect(cadenceLabel({ kind: "daily", hour: 9, minute: 5 })).toBe(
      "Daily at 09:05 UTC",
    );
  });
});

describe("approximateNextRun", () => {
  test("manual triggers have no estimate", () => {
    expect(approximateNextRun(null, new Date())).toBeNull();
  });

  test("webhook triggers have no estimate — they fire on delivery, never a clock", () => {
    expect(
      approximateNextRun(
        { kind: "webhook", webhookTriggerId: "wht_1" },
        new Date(),
      ),
    ).toBeNull();
  });

  test("one-shot triggers have no future estimate", () => {
    expect(approximateNextRun({ kind: "once" }, new Date())).toBeNull();
  });

  test("raw cron is estimated through the same package the hub uses", () => {
    const next = approximateNextRun(
      { kind: "cron", expression: "0 9 * * *" },
      new Date("2026-01-01T08:00:00Z"),
    );
    expect(next?.toISOString()).toBe("2026-01-01T09:00:00.000Z");
  });

  test("interval adds its step to now when now sits on a boundary", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const next = approximateNextRun(
      { kind: "interval", unit: "minutes", every: 15 },
      now,
    );
    expect(next?.toISOString()).toBe("2026-01-01T00:15:00.000Z");
  });

  test("interval is wall-clock aligned, not an offset from the viewing moment", () => {
    const now = new Date("2026-01-01T00:07:00Z");
    const next = approximateNextRun(
      { kind: "interval", unit: "minutes", every: 10 },
      now,
    );
    expect(next?.toISOString()).toBe("2026-01-01T00:10:00.000Z");
  });

  test("hourly interval is wall-clock aligned to the hour", () => {
    const now = new Date("2026-01-01T01:00:00Z");
    const next = approximateNextRun(
      { kind: "interval", unit: "hours", every: 2 },
      now,
    );
    expect(next?.toISOString()).toBe("2026-01-01T02:00:00.000Z");
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

  test("daily with timezone uses local wall-clock (UTC storage)", () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const next = approximateNextRun(
      {
        kind: "daily",
        hour: 9,
        minute: 0,
        timezone: "America/Los_Angeles",
      },
      now,
    );
    expect(next?.toISOString()).toBe("2026-01-15T17:00:00.000Z");
  });

  test("weekly finds the next matching weekday", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const next = approximateNextRun(
      { kind: "weekly", dayOfWeek: 1, hour: 9, minute: 0 },
      now,
    );
    expect(next?.toISOString()).toBe("2026-01-05T09:00:00.000Z");
  });
});
