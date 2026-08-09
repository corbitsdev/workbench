import { describe, expect, test } from "bun:test";
import { type } from "arktype";

import {
  RoutineTrigger,
  computeNextFireAt,
  cronExpressionForTrigger,
  isValidCronExpression,
  timezoneForTrigger,
} from "../src/trigger";

describe("isValidCronExpression", () => {
  test("accepts standard 5-field expressions", () => {
    expect(isValidCronExpression("*/5 * * * *")).toBe(true);
    expect(isValidCronExpression("0 9 * * 1")).toBe(true);
    expect(isValidCronExpression("15,45 * * * *")).toBe(true);
  });

  test("rejects wrong field counts and garbage", () => {
    expect(isValidCronExpression("* * * *")).toBe(false);
    expect(isValidCronExpression("* * * * * *")).toBe(false);
    expect(isValidCronExpression("not a cron string at all")).toBe(false);
    expect(isValidCronExpression("")).toBe(false);
  });

  test("rejects every field out of range, even though the format is fine", () => {
    expect(isValidCronExpression("99 99 99 99 99")).toBe(false);
    expect(isValidCronExpression("0 0 32 * *")).toBe(false);
    expect(isValidCronExpression("0 0 * 13 *")).toBe(false);
    expect(isValidCronExpression("60 * * * *")).toBe(false);
    expect(isValidCronExpression("* * * * 8")).toBe(false);
  });

  test("accepts 7 as Sunday on day-of-week", () => {
    expect(isValidCronExpression("* * * * 7")).toBe(true);
  });

  test("rejects a reversed range, which would otherwise never match", () => {
    expect(isValidCronExpression("10-5 * * * *")).toBe(false);
  });

  test("accepts the standard range-then-step idiom", () => {
    expect(isValidCronExpression("5-10/2 * * * *")).toBe(true);
  });

  test("rejects a reversed range even when it also carries a step", () => {
    expect(isValidCronExpression("10-5/2 * * * *")).toBe(false);
  });
});

describe("RoutineTrigger", () => {
  test("accepts a valid interval preset", () => {
    const result = RoutineTrigger({
      kind: "interval",
      unit: "minutes",
      every: 15,
    });
    expect(result instanceof type.errors).toBe(false);
  });

  test("rejects a non-positive interval", () => {
    const result = RoutineTrigger({
      kind: "interval",
      unit: "minutes",
      every: 0,
    });
    expect(result instanceof type.errors).toBe(true);
  });

  test("accepts a valid daily preset", () => {
    const result = RoutineTrigger({ kind: "daily", hour: 9, minute: 30 });
    expect(result instanceof type.errors).toBe(false);
  });

  test("accepts a daily preset with an IANA timezone", () => {
    const result = RoutineTrigger({
      kind: "daily",
      hour: 9,
      minute: 0,
      timezone: "America/Los_Angeles",
    });
    expect(result instanceof type.errors).toBe(false);
  });

  test("rejects a daily preset with a garbage timezone", () => {
    const result = RoutineTrigger({
      kind: "daily",
      hour: 9,
      minute: 0,
      timezone: "Not/A_Zone",
    });
    expect(result instanceof type.errors).toBe(true);
  });

  test("rejects an out-of-range hour", () => {
    const result = RoutineTrigger({ kind: "daily", hour: 24, minute: 0 });
    expect(result instanceof type.errors).toBe(true);
  });

  test("accepts a valid weekly preset", () => {
    const result = RoutineTrigger({
      kind: "weekly",
      dayOfWeek: 1,
      hour: 9,
      minute: 0,
    });
    expect(result instanceof type.errors).toBe(false);
  });

  test("rejects an out-of-range day of week", () => {
    const result = RoutineTrigger({
      kind: "weekly",
      dayOfWeek: 7,
      hour: 9,
      minute: 0,
    });
    expect(result instanceof type.errors).toBe(true);
  });

  test("accepts a valid raw cron expression", () => {
    const result = RoutineTrigger({ kind: "cron", expression: "*/10 * * * *" });
    expect(result instanceof type.errors).toBe(false);
  });

  test("rejects an invalid raw cron expression with a clear message", () => {
    const result = RoutineTrigger({ kind: "cron", expression: "garbage" });
    expect(result instanceof type.errors).toBe(true);
    if (result instanceof type.errors) {
      expect(result.summary).toContain("valid 5-field cron expression");
    }
  });

  test("rejects an impossible cron expression at save time", () => {
    const result = RoutineTrigger({
      kind: "cron",
      expression: "0 0 31 2 *",
    });
    expect(result instanceof type.errors).toBe(true);
    if (result instanceof type.errors) {
      expect(result.summary).toContain("never fires");
    }
  });

  test("accepts null as a manual, run-now-only routine", () => {
    const result = RoutineTrigger(null);
    expect(result instanceof type.errors).toBe(false);
  });
});

describe("cronExpressionForTrigger", () => {
  test("renders an interval preset to a cron expression", () => {
    expect(
      cronExpressionForTrigger({
        kind: "interval",
        unit: "minutes",
        every: 15,
      }),
    ).toBe("*/15 * * * *");
    expect(
      cronExpressionForTrigger({ kind: "interval", unit: "hours", every: 2 }),
    ).toBe("0 */2 * * *");
  });

  test("renders a daily preset to a cron expression", () => {
    expect(
      cronExpressionForTrigger({ kind: "daily", hour: 9, minute: 30 }),
    ).toBe("30 9 * * *");
  });

  test("renders a weekly preset to a cron expression", () => {
    expect(
      cronExpressionForTrigger({
        kind: "weekly",
        dayOfWeek: 1,
        hour: 9,
        minute: 0,
      }),
    ).toBe("0 9 * * 1");
  });

  test("passes a raw cron trigger through unchanged", () => {
    expect(
      cronExpressionForTrigger({ kind: "cron", expression: "1 2 3 4 5" }),
    ).toBe("1 2 3 4 5");
  });
});

describe("computeNextFireAt", () => {
  test("is null for a manual routine", () => {
    expect(computeNextFireAt(null, new Date())).toBeNull();
  });

  test("finds the next matching minute for an interval preset", () => {
    const after = new Date("2026-01-01T00:07:00Z");
    const next = computeNextFireAt(
      { kind: "interval", unit: "minutes", every: 10 },
      after,
    );
    expect(next?.toISOString()).toBe("2026-01-01T00:10:00.000Z");
  });

  test("finds the next matching minute for a raw cron expression", () => {
    const after = new Date("2026-01-01T00:00:00Z");
    const next = computeNextFireAt(
      { kind: "cron", expression: "0-5 * * * *" },
      after,
    );
    expect(next?.toISOString()).toBe("2026-01-01T00:01:00.000Z");
  });

  test("daily with timezone fires at local wall-clock (UTC storage)", () => {
    // 09:00 America/Los_Angeles in January = 17:00 UTC.
    const after = new Date("2026-01-15T12:00:00Z");
    const next = computeNextFireAt(
      {
        kind: "daily",
        hour: 9,
        minute: 0,
        timezone: "America/Los_Angeles",
      },
      after,
    );
    expect(next?.toISOString()).toBe("2026-01-15T17:00:00.000Z");
  });

  test("timezoneForTrigger defaults to UTC", () => {
    expect(timezoneForTrigger({ kind: "daily", hour: 9, minute: 0 })).toBe(
      "UTC",
    );
    expect(
      timezoneForTrigger({ kind: "interval", unit: "hours", every: 1 }),
    ).toBe("UTC");
    expect(timezoneForTrigger(null)).toBe("UTC");
  });
});
