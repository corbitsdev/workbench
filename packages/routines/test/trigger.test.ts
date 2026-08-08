import { describe, expect, test } from "bun:test";
import { type } from "arktype";

import {
  RoutineTrigger,
  cronExpressionForTrigger,
  isValidCronExpression,
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
