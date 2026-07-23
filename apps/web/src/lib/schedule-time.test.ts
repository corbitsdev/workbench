/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  amountUnitFromInterval,
  anchorToLocalTimeInputValue,
  defaultRecurrence,
  formatLastFiredAt,
  formatNextFire,
  formatRecurrence,
  formatUtcHourLocal,
  intervalFromAmountUnit,
  localTimeInputValueToAnchor,
  onlyDailyAllowedForKind,
} from "./schedule-time";

describe("amountUnitFromInterval / intervalFromAmountUnit", () => {
  it("round-trips a sub-hourly interval (CL-4278)", () => {
    const { amount, unit } = amountUnitFromInterval(5);
    expect(amount).toBe(5);
    expect(unit).toBe("minutes");
    expect(intervalFromAmountUnit(amount, unit)).toBe(5);
  });

  it("decomposes a daily interval to 1 day, not 1440 minutes", () => {
    expect(amountUnitFromInterval(1440)).toEqual({ amount: 1, unit: "days" });
  });

  it("decomposes a weekly interval to 1 week", () => {
    expect(amountUnitFromInterval(10080)).toEqual({
      amount: 1,
      unit: "weeks",
    });
  });

  it("decomposes an hours-multiple interval to hours, not minutes", () => {
    expect(amountUnitFromInterval(180)).toEqual({ amount: 3, unit: "hours" });
  });

  it("falls back to minutes for an interval with no clean larger unit", () => {
    expect(amountUnitFromInterval(7)).toEqual({ amount: 7, unit: "minutes" });
  });

  it("clamps a recomposed interval to the schema's 1..10080 bounds", () => {
    expect(intervalFromAmountUnit(0, "minutes")).toBe(1);
    expect(intervalFromAmountUnit(999, "weeks")).toBe(10080);
  });
});

describe("anchorToLocalTimeInputValue / localTimeInputValueToAnchor", () => {
  it("round-trips a local time-of-day value", () => {
    const value = "08:15";
    const anchor = localTimeInputValueToAnchor(value);
    expect(anchorToLocalTimeInputValue(anchor)).toBe(value);
  });
});

describe("formatRecurrence", () => {
  it("renders a sub-hourly cadence correctly (CL-4278)", () => {
    const label = formatRecurrence({
      intervalMinutes: 5,
      anchorMinuteUtc: 0,
    });
    expect(label).toContain("Every 5 minutes");
    expect(label).toContain("starting at");
  });

  it("renders a daily cadence in plain language", () => {
    const label = formatRecurrence({
      intervalMinutes: 1440,
      anchorMinuteUtc: 0,
    });
    expect(label).toContain("Once a day");
    expect(label).toContain("starting at");
  });

  it("renders a weekly cadence in plain language", () => {
    const label = formatRecurrence({
      intervalMinutes: 10080,
      anchorMinuteUtc: 0,
    });
    expect(label).toContain("Once a week");
  });

  it("renders a multi-unit cadence with pluralized units", () => {
    const label = formatRecurrence({
      intervalMinutes: 180,
      anchorMinuteUtc: 0,
    });
    expect(label).toContain("Every 3 hours");
  });
});

describe("onlyDailyAllowedForKind", () => {
  it("locks heartbeat to a daily-only cadence", () => {
    expect(onlyDailyAllowedForKind("heartbeat")).toBe(true);
  });

  it("leaves other kinds free to pick any interval", () => {
    expect(onlyDailyAllowedForKind("gamma")).toBe(false);
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
