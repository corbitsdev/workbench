import { describe, expect, test } from "bun:test";

import {
  ROUTINE_WEEKDAY_NAMES,
  routineCadenceLabel,
  routineCadenceSummary,
} from "./trigger";

describe("ROUTINE_WEEKDAY_NAMES", () => {
  test("names Sunday through Saturday in cron dayOfWeek order", () => {
    expect(ROUTINE_WEEKDAY_NAMES).toEqual([
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ]);
  });
});

describe("routineCadenceLabel", () => {
  test("a null trigger reads as Manual", () => {
    expect(routineCadenceLabel(null)).toBe("Manual");
  });

  test("a webhook trigger reads as On webhook", () => {
    expect(
      routineCadenceLabel({ kind: "webhook", webhookTriggerId: "wht_1" }),
    ).toBe("On webhook");
  });

  test("a singular interval drops the count", () => {
    expect(
      routineCadenceLabel({ kind: "interval", unit: "minutes", every: 1 }),
    ).toBe("Every minute");
    expect(
      routineCadenceLabel({ kind: "interval", unit: "hours", every: 1 }),
    ).toBe("Every hour");
  });

  test("a plural interval keeps the count and unit", () => {
    expect(
      routineCadenceLabel({ kind: "interval", unit: "minutes", every: 15 }),
    ).toBe("Every 15 minutes");
  });

  test("daily spells out the time and defaults to UTC", () => {
    expect(routineCadenceLabel({ kind: "daily", hour: 9, minute: 5 })).toBe(
      "Daily at 09:05 UTC",
    );
  });

  test("daily with a timezone names it instead of UTC", () => {
    expect(
      routineCadenceLabel({
        kind: "daily",
        hour: 9,
        minute: 0,
        timezone: "America/Los_Angeles",
      }),
    ).toBe("Daily at 09:00 America/Los_Angeles");
  });

  test("weekly names the day and time", () => {
    expect(
      routineCadenceLabel({
        kind: "weekly",
        dayOfWeek: 1,
        hour: 9,
        minute: 30,
      }),
    ).toBe("Weekly on Monday at 09:30 UTC");
  });

  test("cron shows the raw expression, with a timezone suffix when not UTC", () => {
    expect(
      routineCadenceLabel({ kind: "cron", expression: "0 9 * * 1-5" }),
    ).toBe("Cron: 0 9 * * 1-5");
    expect(
      routineCadenceLabel({
        kind: "cron",
        expression: "0 9 * * 1-5",
        timezone: "America/Los_Angeles",
      }),
    ).toBe("Cron: 0 9 * * 1-5 (America/Los_Angeles)");
  });
});

describe("routineCadenceSummary", () => {
  test("a null trigger reads as On demand", () => {
    expect(routineCadenceSummary(null)).toBe("On demand");
  });

  test("a webhook trigger reads as On webhook", () => {
    expect(
      routineCadenceSummary({ kind: "webhook", webhookTriggerId: "wht_1" }),
    ).toBe("On webhook");
  });

  test("interval triggers read as a cadence", () => {
    expect(
      routineCadenceSummary({ kind: "interval", unit: "minutes", every: 15 }),
    ).toBe("Every 15 minutes");
    expect(
      routineCadenceSummary({ kind: "interval", unit: "hours", every: 1 }),
    ).toBe("Every 1 hour");
  });

  test("daily triggers read as a zero-padded time with no zone suffix", () => {
    expect(routineCadenceSummary({ kind: "daily", hour: 9, minute: 0 })).toBe(
      "Daily 09:00",
    );
  });

  test("weekly triggers name the day with no zone suffix", () => {
    expect(
      routineCadenceSummary({
        kind: "weekly",
        dayOfWeek: 1,
        hour: 9,
        minute: 30,
      }),
    ).toBe("Every Monday 09:30");
  });

  test("cron triggers show the expression with no zone suffix", () => {
    expect(
      routineCadenceSummary({ kind: "cron", expression: "0 9 * * 1-5" }),
    ).toBe("Cron 0 9 * * 1-5");
  });
});
