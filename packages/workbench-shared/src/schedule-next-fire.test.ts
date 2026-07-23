import { describe, expect, it } from "bun:test";
import { nextFireAt } from "./schedule-next-fire";

describe("nextFireAt", () => {
  describe("daily cadence (intervalMinutes=1440, anchor=midnight UTC)", () => {
    it("rolls to tomorrow's boundary when today's window already fired", () => {
      const now = new Date("2026-07-13T10:00:00.000Z");
      // Fired today (day index of 2026-07-13, anchor=midnight).
      const todayWindowIndex = Math.floor(now.getTime() / 60_000 / 1440);
      const at = nextFireAt(1440, 0, todayWindowIndex, now);
      expect(at.toISOString()).toBe("2026-07-14T00:00:00.000Z");
    });

    it("reports today's already-passed boundary as imminent when the window hasn't fired (catch-up)", () => {
      const now = new Date("2026-07-13T10:00:00.000Z");
      const todayWindowIndex = Math.floor(now.getTime() / 60_000 / 1440);
      // Fired yesterday, not yet today — the window has advanced past what
      // last fired, so the catch-up rule considers it already due.
      const at = nextFireAt(1440, 0, todayWindowIndex - 1, now);
      expect(at.toISOString()).toBe("2026-07-13T00:00:00.000Z");
    });

    it("treats a never-fired schedule (null) the same as immediately due", () => {
      const now = new Date("2026-07-13T10:00:00.000Z");
      const at = nextFireAt(1440, 0, null, now);
      expect(at.toISOString()).toBe("2026-07-13T00:00:00.000Z");
    });
  });

  describe("sub-daily cadence (every 5 minutes, anchor=0)", () => {
    it("rolls to the next 5-minute boundary once the current window has fired", () => {
      const now = new Date("2026-07-13T13:07:00.000Z");
      const nowMinute = Math.floor(now.getTime() / 60_000);
      const currentWindowIndex = Math.floor(nowMinute / 5);
      const at = nextFireAt(5, 0, currentWindowIndex, now);
      expect(at.toISOString()).toBe("2026-07-13T13:10:00.000Z");
    });

    it("reports the current window's boundary as imminent when a tick skipped it (catch-up)", () => {
      const now = new Date("2026-07-13T13:07:00.000Z");
      const nowMinute = Math.floor(now.getTime() / 60_000);
      const currentWindowIndex = Math.floor(nowMinute / 5);
      const at = nextFireAt(5, 0, currentWindowIndex - 1, now);
      expect(at.toISOString()).toBe("2026-07-13T13:05:00.000Z");
    });
  });
});
