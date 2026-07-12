/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  formatUtcHourLocal,
  localHourToUtc,
  localMinutesOfDay,
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
});
