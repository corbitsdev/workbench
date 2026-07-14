import { describe, expect, it } from "bun:test";
import { nextFireAt } from "./schedule-next-fire";

describe("nextFireAt", () => {
  it("fires later today when the target hour has not passed", () => {
    const now = new Date("2026-07-13T12:30:00.000Z");
    const at = nextFireAt(13, null, now);
    expect(at.toISOString()).toBe("2026-07-13T13:00:00.000Z");
  });

  it("fires tomorrow when today's hour already passed", () => {
    const now = new Date("2026-07-13T14:00:00.000Z");
    const at = nextFireAt(13, null, now);
    expect(at.toISOString()).toBe("2026-07-14T13:00:00.000Z");
  });

  it("fires imminently inside the target hour before today's fire", () => {
    const now = new Date("2026-07-13T13:15:00.000Z");
    const today = Math.floor(now.getTime() / 86_400_000);
    const at = nextFireAt(13, today - 1, now);
    expect(at.toISOString()).toBe("2026-07-13T13:00:00.000Z");
  });

  it("rolls to tomorrow when already fired today", () => {
    const now = new Date("2026-07-13T13:15:00.000Z");
    const today = Math.floor(now.getTime() / 86_400_000);
    const at = nextFireAt(13, today, now);
    expect(at.toISOString()).toBe("2026-07-14T13:00:00.000Z");
  });
});