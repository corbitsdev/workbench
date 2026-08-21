// These tests assert the *contract* — a sentence, in the reader's words,
// naming the zone only when there is a clock to read in it, and never the
// raw expression — not `cronstrue`'s exact phrasing. Pinning the library's
// wording would turn a harmless dependency upgrade into a red build with
// no behaviour change; the interval cases below are ours, so those are
// pinned exactly.

import { describe, expect, test } from "bun:test";

import {
  cronHasWallClock,
  cronSentence,
  routineScheduleSentence,
} from "./schedule-language";

/** Any run of digits or a `*` where a cron field would sit — the thing no
 * reader-facing sentence may ever contain. */
const LOOKS_LIKE_CRON = /\*|\d+\s+\d+\s/;

function expectSentence(sentence: string | null): string {
  expect(sentence).not.toBeNull();
  const text = sentence as string;
  expect(text).not.toMatch(LOOKS_LIKE_CRON);
  expect(text.length).toBeGreaterThan(3);
  return text;
}

describe("cronHasWallClock", () => {
  test("a pinned hour or minute is a clock reading", () => {
    expect(cronHasWallClock("0 9 * * *")).toBe(true);
    expect(cronHasWallClock("30 * * * *")).toBe(true);
  });

  test("a pure cadence has no clock, in any zone", () => {
    expect(cronHasWallClock("* * * * *")).toBe(false);
    expect(cronHasWallClock("*/15 * * * *")).toBe(false);
    expect(cronHasWallClock("* */2 * * *")).toBe(false);
  });
});

describe("cronSentence", () => {
  test("a weekday morning schedule reads as words naming its zone", () => {
    const sentence = expectSentence(cronSentence("0 9 * * 1-5"));
    expect(sentence).toStartWith("At ");
    expect(sentence).toContain("Friday");
    expect(sentence).toEndWith("(UTC)");
  });

  test("the named zone is the one the wall clock is read in", () => {
    expect(cronSentence("30 14 * * *", "America/Los_Angeles")).toEndWith(
      "(America/Los_Angeles)",
    );
  });

  test("a pure cadence names no zone — it is the same in every zone", () => {
    const sentence = expectSentence(cronSentence("*/15 * * * *"));
    expect(sentence).toStartWith("Every ");
    expect(sentence).not.toContain("UTC");
  });

  test("null for an expression that cannot be described", () => {
    expect(cronSentence("not a cron")).toBeNull();
    expect(cronSentence("")).toBeNull();
  });
});

describe("routineScheduleSentence", () => {
  test("a daily preset reads as a clock time in its zone", () => {
    const sentence = expectSentence(
      routineScheduleSentence({ kind: "daily", hour: 9, minute: 0 }),
    );
    expect(sentence).toStartWith("At ");
    expect(sentence).toEndWith("(UTC)");
  });

  test("a weekly preset names its day", () => {
    expect(
      expectSentence(
        routineScheduleSentence({
          kind: "weekly",
          dayOfWeek: 1,
          hour: 7,
          minute: 30,
        }),
      ),
    ).toContain("Monday");
  });

  test("an interval keeps the schedule editor's own words, with no zone", () => {
    expect(
      routineScheduleSentence({ kind: "interval", unit: "hours", every: 6 }),
    ).toBe("Every 6 hours");
    expect(
      routineScheduleSentence({ kind: "interval", unit: "minutes", every: 15 }),
    ).toBe("Every 15 minutes");
    expect(
      routineScheduleSentence({ kind: "interval", unit: "hours", every: 1 }),
    ).toBe("Every hour");
  });

  test("a raw cron trigger never leaks its expression to the reader", () => {
    const sentence = expectSentence(
      routineScheduleSentence({
        kind: "cron",
        expression: "0 9 * * 1,3,5",
        timezone: "Europe/Berlin",
      }),
    );
    expect(sentence).toContain("Monday");
    expect(sentence).toContain("Friday");
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
