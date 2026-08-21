import { describe, expect, test } from "bun:test";
import { type } from "arktype";

import {
  ROUTINE_WEEKDAY_NAMES,
  RoutineTrigger,
  RoutineTriggerWire,
  computeNextFireAt,
  cronExpressionForTrigger,
  cronTriggerForWeekdays,
  routineTriggerCategory,
} from "./trigger";
import { routineScheduleSentence } from "./schedule-language";

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

  test("reads as a sentence that singularizes 'Every 1 days'", () => {
    expect(
      routineScheduleSentence({ kind: "interval", unit: "days", every: 1 }),
    ).toBe("Every day");
    expect(
      routineScheduleSentence({ kind: "interval", unit: "days", every: 3 }),
    ).toBe("Every 3 days");
  });
});

describe("{kind: 'once'} trigger", () => {
  test("is accepted by the strict RoutineTrigger schema", () => {
    const out = RoutineTrigger({ kind: "once" });
    expect(out instanceof type.errors).toBe(false);
  });

  test("is accepted by the liberal RoutineTriggerWire schema", () => {
    const out = RoutineTriggerWire({ kind: "once" });
    expect(out instanceof type.errors).toBe(false);
  });

  test("never computes a next fire — it is not a scheduled trigger", () => {
    expect(computeNextFireAt({ kind: "once" }, new Date())).toBeNull();
  });

  test("categorizes as 'demand', same as manual — not 'schedule'", () => {
    expect(routineTriggerCategory({ kind: "once" })).toBe("demand");
  });

  test("reads as a one-time schedule, not a cadence", () => {
    expect(routineScheduleSentence({ kind: "once" })).toBe(
      "Once, when it was created",
    );
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
