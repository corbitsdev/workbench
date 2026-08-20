import { describe, expect, test } from "bun:test";

import { cronSentence, routineScheduleSentence } from "./schedule-language";

const RAW_CRON = /\*|\d+ \d+ \* \* /;

describe("cronSentence", () => {
  test("reads a weekday morning schedule as a sentence, never the expression", () => {
    const sentence = cronSentence("0 9 * * 1-5");
    expect(sentence).toBe("At 09:00, Monday through Friday (UTC)");
    expect(sentence).not.toMatch(RAW_CRON);
  });

  test("names the timezone the wall clock is read in", () => {
    expect(cronSentence("30 14 * * *", "America/Los_Angeles")).toBe(
      "At 14:30 (America/Los_Angeles)",
    );
  });

  test("reads a step expression as a frequency", () => {
    expect(cronSentence("*/15 * * * *")).toBe("Every 15 minutes (UTC)");
  });

  test("reads a day-of-month expression", () => {
    expect(cronSentence("0 0 1 * *")).toContain("day 1 of the month");
  });

  test("null for an expression that cannot be described", () => {
    expect(cronSentence("not a cron")).toBeNull();
    expect(cronSentence("")).toBeNull();
  });
});

describe("routineScheduleSentence", () => {
  test("every clock-driven preset reads as a sentence", () => {
    expect(routineScheduleSentence({ kind: "daily", hour: 9, minute: 0 })).toBe(
      "At 09:00 (UTC)",
    );
    expect(
      routineScheduleSentence({
        kind: "weekly",
        dayOfWeek: 1,
        hour: 7,
        minute: 30,
      }),
    ).toBe("At 07:30, only on Monday (UTC)");
    expect(
      routineScheduleSentence({ kind: "interval", unit: "hours", every: 6 }),
    ).toBe("On the hour, every 6 hours (UTC)");
  });

  test("a raw cron trigger never leaks its expression to the reader", () => {
    const sentence = routineScheduleSentence({
      kind: "cron",
      expression: "0 9 * * 1,3,5",
      timezone: "Europe/Berlin",
    });
    expect(sentence).toContain("Monday, Wednesday, and Friday");
    expect(sentence).toContain("Europe/Berlin");
    expect(sentence).not.toContain("1,3,5");
  });

  test("the non-clock triggers each get their own words", () => {
    expect(routineScheduleSentence(null)).toBe("On demand only");
    expect(
      routineScheduleSentence({ kind: "webhook", webhookTriggerId: "wht_1" }),
    ).toBe("When its webhook receives a delivery");
    expect(routineScheduleSentence({ kind: "once" })).toBe(
      "Once, when it was created",
    );
  });

  test("an expression saved before a stricter check says so instead of printing itself", () => {
    expect(
      routineScheduleSentence({ kind: "cron", expression: "garbage" }),
    ).toBe("Schedule not readable");
  });
});
