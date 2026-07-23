/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  decodeRecurrenceKey,
  defaultRecurrence,
  encodeRecurrence,
  formatLastFiredAt,
  formatNextFire,
  formatRecurrence,
  formatUtcHourLocal,
  recurrenceOptions,
} from "./schedule-time";

describe("recurrenceOptions", () => {
  it("offers all 24 daily-hour options plus the sub-daily interval presets", () => {
    const options = recurrenceOptions();
    const dailyKeys = options.filter((o) => o.key.startsWith("daily:"));
    const intervalKeys = options.filter((o) => o.key.startsWith("interval:"));
    expect(dailyKeys).toHaveLength(24);
    expect(intervalKeys.length).toBeGreaterThan(0);
    expect(new Set(options.map((o) => o.key)).size).toBe(options.length);
  });

  it("labels every daily option with a clock time", () => {
    for (const { key, label } of recurrenceOptions()) {
      if (!key.startsWith("daily:")) continue;
      expect(label).toMatch(/\d/);
    }
  });

  it("labels sub-daily options in plain minutes/hour language", () => {
    const labels = recurrenceOptions()
      .filter((o) => o.key.startsWith("interval:"))
      .map((o) => o.label);
    expect(labels).toContain("Every 5 minutes");
    expect(labels).toContain("Every hour");
  });
});

describe("encodeRecurrence / decodeRecurrenceKey", () => {
  it("round-trips a daily recurrence through its key", () => {
    const recurrence = { intervalMinutes: 1440, anchorMinuteUtc: 9 * 60 };
    const key = encodeRecurrence(recurrence);
    expect(decodeRecurrenceKey(key)).toEqual(recurrence);
  });

  it("round-trips a sub-daily preset recurrence through its key", () => {
    const recurrence = { intervalMinutes: 5, anchorMinuteUtc: 0 };
    const key = encodeRecurrence(recurrence);
    expect(decodeRecurrenceKey(key)).toEqual(recurrence);
  });

  it("falls back to the nearest daily hour for a recurrence with no preset key", () => {
    // e.g. an every-20-minutes schedule set via the API directly, not the
    // picker's presets — must still resolve to a real, non-blank selection.
    const recurrence = { intervalMinutes: 20, anchorMinuteUtc: 3 * 60 };
    const key = encodeRecurrence(recurrence);
    expect(key).toBe("daily:3");
  });
});

describe("formatRecurrence", () => {
  it("formats a daily recurrence in local clock time", () => {
    const label = formatRecurrence({
      intervalMinutes: 1440,
      anchorMinuteUtc: 0,
    });
    expect(label).toContain("Daily at");
  });

  it("formats a sub-daily recurrence in plain language", () => {
    expect(formatRecurrence({ intervalMinutes: 5, anchorMinuteUtc: 0 })).toBe(
      "Every 5 minutes",
    );
    expect(formatRecurrence({ intervalMinutes: 60, anchorMinuteUtc: 0 })).toBe(
      "Every hour",
    );
  });
});

describe("defaultRecurrence", () => {
  it("defaults to a daily cadence at the current local hour", () => {
    const recurrence = defaultRecurrence();
    expect(recurrence.intervalMinutes).toBe(1440);
    expect(recurrence.anchorMinuteUtc % 60).toBe(0);
  });
});

describe("formatUtcHourLocal", () => {
  it("formats a UTC hour as a local wall-clock time", () => {
    expect(formatUtcHourLocal(0)).toMatch(/\d/);
  });
});

describe("formatLastFiredAt", () => {
  it("reports never-fired schedules distinctly from fired ones", () => {
    expect(formatLastFiredAt(null)).toBe("Not yet fired");
    expect(formatLastFiredAt("2026-01-05T14:00:00.000Z")).not.toBe(
      "Not yet fired",
    );
  });
});

describe("formatNextFire", () => {
  it("reports paused schedules as paused regardless of hub nextFireAt", () => {
    expect(formatNextFire("2026-01-05T14:00:00.000Z", false)).toBe("Paused");
    expect(formatNextFire(null, true)).toBe("Paused");
  });

  it("formats hub nextFireAt for enabled schedules", () => {
    const label = formatNextFire("2026-01-05T14:00:00.000Z", true);
    expect(label).not.toBe("Paused");
    expect(label.length).toBeGreaterThan(0);
  });
});
