import { describe, expect, test } from "bun:test";
import { type } from "arktype";

import {
  ROUTINE_WEEKDAY_NAMES,
  RoutineTrigger,
  RoutineTriggerWire,
  cronExpressionForTrigger,
  cronTriggerForWeekdays,
  routineCadenceLabel,
  routineCadenceSummary,
} from "./trigger";

describe("RoutineTrigger vs RoutineTriggerWire (Postel's law)", () => {
  test("an unrecognized timezone is rejected on write by RoutineTrigger", () => {
    const out = RoutineTrigger({
      kind: "daily",
      hour: 9,
      minute: 0,
      timezone: "Mars/Olympus_Mons",
    });
    expect(out instanceof type.errors).toBe(true);
  });

  test("the same unrecognized timezone still parses on read via RoutineTriggerWire", () => {
    const out = RoutineTriggerWire({
      kind: "daily",
      hour: 9,
      minute: 0,
      timezone: "Mars/Olympus_Mons",
    });
    expect(out instanceof type.errors).toBe(false);
  });

  test("a cron expression that never fires within a year is rejected on write", () => {
    const out = RoutineTrigger({
      kind: "cron",
      expression: "0 0 30 2 *",
    });
    expect(out instanceof type.errors).toBe(true);
  });

  test("the same never-fires cron expression still parses on read", () => {
    const out = RoutineTriggerWire({
      kind: "cron",
      expression: "0 0 30 2 *",
    });
    expect(out instanceof type.errors).toBe(false);
  });
});

describe("ROUTINE_WEEKDAY_NAMES", () => {
  test("names Sunday through Saturday in cron dayOfWeek order", () => {
    expect(ROUTINE_WEEKDAY_NAMES).toEqual([
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ]);
  });
});

describe("routineCadenceLabel", () => {
  test("a null trigger reads as Manual", () => {
    expect(routineCadenceLabel(null)).toBe("Manual");
  });

  test("a webhook trigger reads as On webhook", () => {
    expect(
      routineCadenceLabel({ kind: "webhook", webhookTriggerId: "wht_1" }),
    ).toBe("On webhook");
  });

  test("a singular interval drops the count", () => {
    expect(
      routineCadenceLabel({ kind: "interval", unit: "minutes", every: 1 }),
    ).toBe("Every minute");
    expect(
      routineCadenceLabel({ kind: "interval", unit: "hours", every: 1 }),
    ).toBe("Every hour");
  });

  test("a plural interval keeps the count and unit", () => {
    expect(
      routineCadenceLabel({ kind: "interval", unit: "minutes", every: 15 }),
    ).toBe("Every 15 minutes");
  });

  test("daily spells out the time and defaults to UTC", () => {
    expect(routineCadenceLabel({ kind: "daily", hour: 9, minute: 5 })).toBe(
      "Daily at 09:05 UTC",
    );
  });

  test("daily with a timezone names it instead of UTC", () => {
    expect(
      routineCadenceLabel({
        kind: "daily",
        hour: 9,
        minute: 0,
        timezone: "America/Los_Angeles",
      }),
    ).toBe("Daily at 09:00 America/Los_Angeles");
  });

  test("weekly names the day and time", () => {
    expect(
      routineCadenceLabel({
        kind: "weekly",
        dayOfWeek: 1,
        hour: 9,
        minute: 30,
      }),
    ).toBe("Weekly on Monday at 09:30 UTC");
  });

  test("cron shows the raw expression, with a timezone suffix when not UTC", () => {
    expect(
      routineCadenceLabel({ kind: "cron", expression: "0 9 * * 1-5" }),
    ).toBe("Cron: 0 9 * * 1-5");
    expect(
      routineCadenceLabel({
        kind: "cron",
        expression: "0 9 * * 1-5",
        timezone: "America/Los_Angeles",
      }),
    ).toBe("Cron: 0 9 * * 1-5 (America/Los_Angeles)");
  });
});

describe("routineCadenceSummary", () => {
  test("a null trigger reads as On demand", () => {
    expect(routineCadenceSummary(null)).toBe("On demand");
  });

  test("a webhook trigger reads as On webhook", () => {
    expect(
      routineCadenceSummary({ kind: "webhook", webhookTriggerId: "wht_1" }),
    ).toBe("On webhook");
  });

  test("interval triggers read as a cadence", () => {
    expect(
      routineCadenceSummary({ kind: "interval", unit: "minutes", every: 15 }),
    ).toBe("Every 15 minutes");
    expect(
      routineCadenceSummary({ kind: "interval", unit: "hours", every: 1 }),
    ).toBe("Every 1 hour");
  });

  test("daily triggers read as a zero-padded time with no zone suffix", () => {
    expect(routineCadenceSummary({ kind: "daily", hour: 9, minute: 0 })).toBe(
      "Daily 09:00",
    );
  });

  test("weekly triggers name the day with no zone suffix", () => {
    expect(
      routineCadenceSummary({
        kind: "weekly",
        dayOfWeek: 1,
        hour: 9,
        minute: 30,
      }),
    ).toBe("Every Monday 09:30");
  });

  test("cron triggers show the expression with no zone suffix", () => {
    expect(
      routineCadenceSummary({ kind: "cron", expression: "0 9 * * 1-5" }),
    ).toBe("Cron 0 9 * * 1-5");
  });
});

describe("interval trigger 'days' unit", () => {
  test("is accepted by the strict RoutineTrigger schema", () => {
    const out = RoutineTrigger({ kind: "interval", unit: "days", every: 3 });
    expect(out instanceof type.errors).toBe(false);
  });

  test("renders to a day-of-month step cron expression", () => {
    expect(
      cronExpressionForTrigger({ kind: "interval", unit: "days", every: 3 }),
    ).toBe("0 0 */3 * *");
  });

  test("cadence label singularizes 'Every 1 days' to 'Every day'", () => {
    expect(
      routineCadenceLabel({ kind: "interval", unit: "days", every: 1 }),
    ).toBe("Every day");
    expect(
      routineCadenceLabel({ kind: "interval", unit: "days", every: 3 }),
    ).toBe("Every 3 days");
  });

  test("cadence summary singularizes the unit for every === 1", () => {
    expect(
      routineCadenceSummary({ kind: "interval", unit: "days", every: 1 }),
    ).toBe("Every 1 day");
  });
});

describe("cronTriggerForWeekdays", () => {
  test("renders a single day the same as multiple", () => {
    expect(cronTriggerForWeekdays([1], 9, 0)).toEqual({
      kind: "cron",
      expression: "0 9 * * 1",
    });
  });

  test("sorts and de-dupes days into one comma-joined field", () => {
    expect(cronTriggerForWeekdays([5, 1, 3, 1], 9, 0)).toEqual({
      kind: "cron",
      expression: "0 9 * * 1,3,5",
    });
  });

  test("carries an optional timezone", () => {
    expect(
      cronTriggerForWeekdays([1, 2, 3, 4, 5], 9, 0, "America/Los_Angeles"),
    ).toEqual({
      kind: "cron",
      expression: "0 9 * * 1,2,3,4,5",
      timezone: "America/Los_Angeles",
    });
  });

  test("rejects an empty day list", () => {
    expect(() => cronTriggerForWeekdays([], 9, 0)).toThrow();
  });

  test("the resulting cron trigger passes strict RoutineTrigger validation", () => {
    const trigger = cronTriggerForWeekdays([1, 2, 3, 4, 5], 9, 0);
    const out = RoutineTrigger(trigger);
    expect(out instanceof type.errors).toBe(false);
  });
});
