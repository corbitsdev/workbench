// Pure-function proof for the panel's inline schedule editor (CL-6139):
// the five presets and the two custom builders each render through
// `@corbits/routines/trigger`'s own cron builders — no hand-rolled cron
// here. DOM interaction for the editor itself is covered by
// routine-panel.test.tsx (the schedule commits through the panel's real
// autosave path); this file only proves each cadence's own shape.

import { describe, expect, test } from "bun:test";
import {
  customAtTrigger,
  customIntervalTrigger,
  matchingPresetId,
  SCHEDULE_PRESETS,
} from "../src/routine-schedule";

describe("SCHEDULE_PRESETS", () => {
  test("Every 15 min is a 15-minute interval", () => {
    const preset = SCHEDULE_PRESETS.find((p) => p.id === "every-15-min");
    expect(preset?.trigger()).toEqual({
      kind: "interval",
      unit: "minutes",
      every: 15,
    });
  });

  test("Hourly is a 1-hour interval", () => {
    const preset = SCHEDULE_PRESETS.find((p) => p.id === "hourly");
    expect(preset?.trigger()).toEqual({
      kind: "interval",
      unit: "hours",
      every: 1,
    });
  });

  test("Daily 9:00 is a daily trigger at 09:00", () => {
    const preset = SCHEDULE_PRESETS.find((p) => p.id === "daily-9");
    expect(preset?.trigger()).toEqual({ kind: "daily", hour: 9, minute: 0 });
  });

  test("Weekdays 9:00 renders through cronTriggerForWeekdays (Mon–Fri)", () => {
    const preset = SCHEDULE_PRESETS.find((p) => p.id === "weekdays-9");
    expect(preset?.trigger()).toEqual({
      kind: "cron",
      expression: "0 9 * * 1,2,3,4,5",
    });
  });

  test("Weekly Mon 9:00 is a weekly trigger on Monday at 09:00", () => {
    const preset = SCHEDULE_PRESETS.find((p) => p.id === "weekly-mon-9");
    expect(preset?.trigger()).toEqual({
      kind: "weekly",
      dayOfWeek: 1,
      hour: 9,
      minute: 0,
    });
  });

  test("matchingPresetId finds the preset a trigger equals, or null for a custom cadence", () => {
    expect(
      matchingPresetId({ kind: "interval", unit: "hours", every: 1 }),
    ).toBe("hourly");
    expect(
      matchingPresetId({ kind: "interval", unit: "hours", every: 3 }),
    ).toBeNull();
  });
});

describe("customIntervalTrigger", () => {
  test("builds an interval trigger for each unit", () => {
    expect(customIntervalTrigger(5, "minutes")).toEqual({
      kind: "interval",
      unit: "minutes",
      every: 5,
    });
    expect(customIntervalTrigger(2, "hours")).toEqual({
      kind: "interval",
      unit: "hours",
      every: 2,
    });
    expect(customIntervalTrigger(3, "days")).toEqual({
      kind: "interval",
      unit: "days",
      every: 3,
    });
  });

  test("clamps a non-positive or fractional every to a positive integer", () => {
    expect(customIntervalTrigger(0, "minutes")).toEqual({
      kind: "interval",
      unit: "minutes",
      every: 1,
    });
    expect(customIntervalTrigger(2.7, "minutes")).toEqual({
      kind: "interval",
      unit: "minutes",
      every: 2,
    });
  });
});

describe("customAtTrigger", () => {
  test("a single day renders as the weekly shape", () => {
    expect(customAtTrigger(9, 30, [3])).toEqual({
      kind: "weekly",
      dayOfWeek: 3,
      hour: 9,
      minute: 30,
    });
  });

  test("multiple days render through cronTriggerForWeekdays", () => {
    expect(customAtTrigger(9, 0, [1, 3, 5])).toEqual({
      kind: "cron",
      expression: "0 9 * * 1,3,5",
    });
  });

  test("no day picked yet has nothing to commit", () => {
    expect(customAtTrigger(9, 0, [])).toBeNull();
  });
});
