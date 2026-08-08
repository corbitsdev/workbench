// Pure-function proof for the scheduler's "is it time yet" decision — no
// clock, database, or launch involved. `cronExpressionForTrigger`
// (@corbits/routines) is the only producer of these expressions in this
// repo today; these cases cover its four preset renderings plus the
// raw-cron escape hatch's comma/range/step grammar.

import { describe, expect, test } from "bun:test";
import { cronMatchesMinute, minuteKey } from "../src/cron-due.ts";

describe("cronMatchesMinute", () => {
  test("interval preset: */15 * * * *", () => {
    const expression = "*/15 * * * *";
    expect(
      cronMatchesMinute(expression, new Date("2026-01-01T00:00:00Z")),
    ).toBe(true);
    expect(
      cronMatchesMinute(expression, new Date("2026-01-01T00:15:00Z")),
    ).toBe(true);
    expect(
      cronMatchesMinute(expression, new Date("2026-01-01T00:07:00Z")),
    ).toBe(false);
  });

  test("hourly interval preset: 0 */2 * * *", () => {
    const expression = "0 */2 * * *";
    expect(
      cronMatchesMinute(expression, new Date("2026-01-01T02:00:00Z")),
    ).toBe(true);
    expect(
      cronMatchesMinute(expression, new Date("2026-01-01T03:00:00Z")),
    ).toBe(false);
    expect(
      cronMatchesMinute(expression, new Date("2026-01-01T02:01:00Z")),
    ).toBe(false);
  });

  test("daily preset: 30 9 * * *", () => {
    const expression = "30 9 * * *";
    expect(
      cronMatchesMinute(expression, new Date("2026-01-01T09:30:00Z")),
    ).toBe(true);
    expect(
      cronMatchesMinute(expression, new Date("2026-01-01T09:31:00Z")),
    ).toBe(false);
    expect(
      cronMatchesMinute(expression, new Date("2026-01-02T09:30:00Z")),
    ).toBe(true);
  });

  test("weekly preset: 0 12 * * 1 (Monday)", () => {
    const expression = "0 12 * * 1";
    // 2026-01-05 is a Monday.
    expect(
      cronMatchesMinute(expression, new Date("2026-01-05T12:00:00Z")),
    ).toBe(true);
    expect(
      cronMatchesMinute(expression, new Date("2026-01-06T12:00:00Z")),
    ).toBe(false);
  });

  test("raw cron: ranges, steps, and comma lists", () => {
    expect(
      cronMatchesMinute("0-5 * * * *", new Date("2026-01-01T00:03:00Z")),
    ).toBe(true);
    expect(
      cronMatchesMinute("0-5 * * * *", new Date("2026-01-01T00:06:00Z")),
    ).toBe(false);
    expect(
      cronMatchesMinute("*/10 * * * *", new Date("2026-01-01T00:20:00Z")),
    ).toBe(true);
    expect(
      cronMatchesMinute("0,30 * * * *", new Date("2026-01-01T00:30:00Z")),
    ).toBe(true);
    expect(
      cronMatchesMinute("0,30 * * * *", new Date("2026-01-01T00:15:00Z")),
    ).toBe(false);
  });

  test("rejects an expression without exactly five fields", () => {
    expect(() => cronMatchesMinute("* * * *", new Date())).toThrow();
  });
});

describe("minuteKey", () => {
  test("is stable within a minute and distinct across minutes", () => {
    const a = minuteKey(new Date("2026-01-01T00:00:00.000Z"));
    const b = minuteKey(new Date("2026-01-01T00:00:59.999Z"));
    const c = minuteKey(new Date("2026-01-01T00:01:00.000Z"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
