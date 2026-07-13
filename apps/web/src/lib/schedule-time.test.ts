/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  formatLastFired,
  formatNextFire,
  formatUtcHourLocal,
  localHourToUtc,
  localMinutesOfDay,
  nextFireAt,
  utcHourOptions,
} from "./schedule-time";

describe("schedule-time", () => {
  it("offers all 24 UTC hours exactly once", () => {
    const options = utcHourOptions();
    expect(options).toHaveLength(24);
    const hours = new Set(options.map((o) => o.hourUtc));
    expect(hours.size).toBe(24);
    for (let h = 0; h < 24; h++) expect(hours.has(h)).toBe(true);
  });

  it("orders options by the local clock, not by UTC", () => {
    const options = utcHourOptions();
    const minutes = options.map((o) => localMinutesOfDay(o.hourUtc));
    const sorted = [...minutes].sort((a, b) => a - b);
    expect(minutes).toEqual(sorted);
  });

  it("labels every option with a clock time", () => {
    for (const { label } of utcHourOptions()) {
      expect(label).toMatch(/\d/);
      expect(label).toContain(":00");
    }
  });

  it("round-trips a local hour through UTC back to the same local minute", () => {
    const utc = localHourToUtc(8);
    expect(utc).toBeGreaterThanOrEqual(0);
    expect(utc).toBeLessThanOrEqual(23);
    // 8:00 local is 8 * 60 minutes past local midnight. Half-hour zones can't
    // round-trip through an integer UTC hour, so only assert on whole-hour zones.
    if (new Date().getTimezoneOffset() % 60 === 0) {
      expect(localMinutesOfDay(utc)).toBe(8 * 60);
    }
  });

  it("formats a UTC hour as a local wall-clock time", () => {
    expect(formatUtcHourLocal(localHourToUtc(0))).toContain("12:00");
  });

  it("reports never-fired schedules distinctly from fired ones", () => {
    expect(formatLastFired(null)).toBe("Not yet fired");
    expect(formatLastFired(0)).not.toBe("Not yet fired");
  });

  it("computes the next fire as today when the hour hasn't passed and it hasn't fired today", () => {
    const now = new Date("2026-01-05T10:00:00.000Z");
    const todayUtcDay = Math.floor(now.getTime() / 86_400_000);
    const next = nextFireAt(14, null, now);
    expect(Math.floor(next.getTime() / 86_400_000)).toBe(todayUtcDay);
    expect(next.getUTCHours()).toBe(14);
  });

  it("rolls the next fire to tomorrow once the hour has passed today", () => {
    const now = new Date("2026-01-05T15:00:00.000Z");
    const todayUtcDay = Math.floor(now.getTime() / 86_400_000);
    const next = nextFireAt(14, null, now);
    expect(Math.floor(next.getTime() / 86_400_000)).toBe(todayUtcDay + 1);
  });

  it("reports next fire as today (this hour) when now is inside the target hour and it hasn't fired yet", () => {
    // Mirrors scheduler.shouldFire: hour match + not fired today => fires on
    // the very next tick, so nextFireAt must not roll to tomorrow here.
    const now = new Date("2026-01-05T14:30:00.000Z");
    const todayUtcDay = Math.floor(now.getTime() / 86_400_000);
    const next = nextFireAt(14, null, now);
    expect(Math.floor(next.getTime() / 86_400_000)).toBe(todayUtcDay);
    expect(next.getUTCHours()).toBe(14);
  });

  it("rolls the next fire to tomorrow when it already fired today", () => {
    const now = new Date("2026-01-05T10:00:00.000Z");
    const todayUtcDay = Math.floor(now.getTime() / 86_400_000);
    const next = nextFireAt(14, todayUtcDay, now);
    expect(Math.floor(next.getTime() / 86_400_000)).toBe(todayUtcDay + 1);
  });

  it("reports paused schedules as paused regardless of hour", () => {
    expect(formatNextFire(14, null, false)).toBe("Paused");
  });

  it("reports a next-fire label for enabled schedules", () => {
    const label = formatNextFire(
      14,
      null,
      true,
      new Date("2026-01-05T10:00:00.000Z"),
    );
    expect(label).not.toBe("Paused");
    expect(label.length).toBeGreaterThan(0);
  });
});
