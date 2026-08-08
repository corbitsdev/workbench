import { describe, expect, test } from "bun:test";
import {
  computeNextRun,
  InvalidTriggerError,
  validateTrigger,
} from "../src/trigger";

describe("validateTrigger", () => {
  test("accepts a well-formed cron expression", () => {
    expect(() =>
      validateTrigger({ kind: "cron", expression: "0 * * * *" }),
    ).not.toThrow();
  });

  test("rejects a malformed cron expression", () => {
    expect(() =>
      validateTrigger({ kind: "cron", expression: "not a cron" }),
    ).toThrow(InvalidTriggerError);
  });

  test("accepts a positive interval", () => {
    expect(() =>
      validateTrigger({ kind: "interval", ms: 60_000 }),
    ).not.toThrow();
  });

  test("rejects a zero or negative interval", () => {
    expect(() => validateTrigger({ kind: "interval", ms: 0 })).toThrow(
      InvalidTriggerError,
    );
    expect(() => validateTrigger({ kind: "interval", ms: -1 })).toThrow(
      InvalidTriggerError,
    );
  });

  test("rejects a non-finite interval", () => {
    expect(() =>
      validateTrigger({ kind: "interval", ms: Number.POSITIVE_INFINITY }),
    ).toThrow(InvalidTriggerError);
    expect(() => validateTrigger({ kind: "interval", ms: Number.NaN })).toThrow(
      InvalidTriggerError,
    );
  });
});

describe("computeNextRun", () => {
  test("interval trigger advances by exactly its ms, not compounding", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const next = computeNextRun({ kind: "interval", ms: 90_000 }, from);
    expect(next.toISOString()).toBe("2026-01-01T00:01:30.000Z");
  });

  test("cron trigger fires on the next matching minute boundary", () => {
    // "0 * * * *" is minute 0 of every hour.
    const from = new Date("2026-01-01T00:00:00.000Z");
    const next = computeNextRun(
      { kind: "cron", expression: "0 * * * *" },
      from,
    );
    expect(next.toISOString()).toBe("2026-01-01T01:00:00.000Z");
  });

  test("cron trigger crossing a month/year boundary", () => {
    const from = new Date("2025-12-31T23:59:00.000Z");
    const next = computeNextRun(
      { kind: "cron", expression: "0 0 1 * *" },
      from,
    );
    expect(next.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  test("cron trigger honoring a day-of-week restriction", () => {
    // 2026-01-01 is a Thursday; "0 9 * * 1" is 09:00 every Monday.
    const from = new Date("2026-01-01T00:00:00.000Z");
    const next = computeNextRun(
      { kind: "cron", expression: "0 9 * * 1" },
      from,
    );
    expect(next.getUTCDay()).toBe(1);
    expect(next.getUTCHours()).toBe(9);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });
});
