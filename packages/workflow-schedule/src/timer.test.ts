import { describe, expect, test } from "bun:test";

import { armCronTimer } from "./timer";

const newTimerId = () => "timer_1";

describe("armCronTimer", () => {
  test("arms the next tick strictly after now", () => {
    const armed = armCronTimer({
      cron: "0 * * * *",
      now: new Date("2026-01-01T09:00:00.000Z"),
      newTimerId,
    });
    expect(armed).toEqual({
      timerId: "timer_1",
      fireAt: "2026-01-01T10:00:00.000Z",
      cron: "0 * * * *",
    });
  });

  test("a tick observed late skips the missed ticks rather than arming in the past", () => {
    const armed = armCronTimer({
      cron: "0 * * * *",
      firedAt: new Date("2026-01-01T09:00:00.000Z"),
      now: new Date("2026-01-01T12:30:00.000Z"),
      newTimerId,
    });
    expect(armed.fireAt).toBe("2026-01-01T13:00:00.000Z");
  });

  test("reads the expression in the given zone", () => {
    const armed = armCronTimer({
      cron: "30 9 * * *",
      now: new Date("2026-01-01T09:00:00.000Z"),
      timeZone: "America/New_York",
      newTimerId,
    });
    expect(armed.fireAt).toBe("2026-01-01T14:30:00.000Z");
  });
});
