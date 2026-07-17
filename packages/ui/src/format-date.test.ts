import { describe, expect, test } from "bun:test";
import {
  formatAbsoluteUtc,
  formatDateTimeMedium,
  formatDuration,
  formatFullTimestamp,
  formatRelativeTime,
  formatShortDateRangeUtc,
  formatShortDateUtc,
  formatTimeOnly,
} from "./format-date";

describe("formatShortDateUtc", () => {
  test("formats a UTC date without a year by default", () => {
    expect(formatShortDateUtc("2026-01-05T23:00:00Z")).toBe("Jan 5");
  });

  test("includes the year when requested", () => {
    expect(
      formatShortDateUtc("2026-01-05T23:00:00Z", { includeYear: true }),
    ).toBe("Jan 5, 2026");
  });

  test("stays UTC-pinned across the local midnight boundary", () => {
    expect(formatShortDateUtc("2026-01-06T00:30:00Z")).toBe("Jan 6");
  });
});

describe("formatShortDateRangeUtc", () => {
  test("formats a range with the start date short and the end date full", () => {
    expect(
      formatShortDateRangeUtc("2026-01-05T00:00:00Z", "2026-02-03T00:00:00Z"),
    ).toBe("Jan 5 – Feb 3, 2026");
  });

  test("falls back to the raw inputs when either date is invalid", () => {
    expect(formatShortDateRangeUtc("not-a-date", "2026-02-03T00:00:00Z")).toBe(
      "not-a-date–2026-02-03T00:00:00Z",
    );
  });
});

describe("formatDateTimeMedium", () => {
  test("returns a non-empty locale-formatted string for a valid date", () => {
    const result = formatDateTimeMedium("2026-01-05T15:04:00Z");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("2026");
  });

  test("falls back to the raw input for an invalid date", () => {
    expect(formatDateTimeMedium("not-a-date")).toBe("not-a-date");
  });
});

describe("formatFullTimestamp", () => {
  test("includes year, month, day, and time fields", () => {
    const result = formatFullTimestamp("2026-01-05T15:04:12Z");
    expect(result).toContain("2026");
    expect(result).toContain("Jan");
  });

  test("falls back to the raw input for an invalid date", () => {
    expect(formatFullTimestamp("not-a-date")).toBe("not-a-date");
  });
});

describe("formatTimeOnly", () => {
  test("returns a non-empty time string for a valid date", () => {
    const result = formatTimeOnly("2026-01-05T15:04:00Z");
    expect(result.length).toBeGreaterThan(0);
  });

  test("falls back to the raw input for an invalid date", () => {
    expect(formatTimeOnly("not-a-date")).toBe("not-a-date");
  });
});

describe("formatAbsoluteUtc", () => {
  test("formats an ISO string as a locale-independent UTC label", () => {
    expect(formatAbsoluteUtc("2026-01-05T15:04:12Z")).toBe(
      "2026-01-05 15:04 UTC",
    );
  });

  test("falls back to the raw input for an invalid date", () => {
    expect(formatAbsoluteUtc("not-a-date")).toBe("not-a-date");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-01-05T12:00:00Z");

  test("returns 'just now' for sub-minute deltas", () => {
    expect(formatRelativeTime(new Date("2026-01-05T11:59:30Z"), now)).toBe(
      "just now",
    );
  });

  test("returns minutes for sub-hour deltas", () => {
    expect(formatRelativeTime(new Date("2026-01-05T11:55:00Z"), now)).toBe(
      "5m ago",
    );
  });

  test("returns hours for sub-day deltas", () => {
    expect(formatRelativeTime(new Date("2026-01-05T09:00:00Z"), now)).toBe(
      "3h ago",
    );
  });

  test("returns days for multi-day deltas, uncapped", () => {
    expect(formatRelativeTime(new Date("2025-12-29T12:00:00Z"), now)).toBe(
      "7d ago",
    );
  });
});

describe("formatDuration", () => {
  test("formats sub-second durations in milliseconds", () => {
    expect(formatDuration(450)).toBe("450ms");
  });

  test("formats sub-10s durations with one decimal", () => {
    expect(formatDuration(3200)).toBe("3.2s");
  });

  test("formats 10s-59s durations with no decimal", () => {
    expect(formatDuration(45_000)).toBe("45s");
  });

  test("formats multi-minute durations as minutes and seconds", () => {
    expect(formatDuration(65_000)).toBe("1m 5s");
  });
});
