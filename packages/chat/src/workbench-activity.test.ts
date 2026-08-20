import { describe, expect, test } from "bun:test";
import {
  isRecentlyActive,
  LIVE_ACTIVITY_WINDOW_MS,
} from "./workbench-activity";

describe("isRecentlyActive", () => {
  test("true right at the edge of the window", () => {
    const now = new Date("2026-01-01T00:10:00.000Z");
    const lastActivityAt = new Date(
      now.getTime() - LIVE_ACTIVITY_WINDOW_MS,
    ).toISOString();
    expect(isRecentlyActive(lastActivityAt, now)).toBe(true);
  });

  test("false one millisecond past the window", () => {
    const now = new Date("2026-01-01T00:10:00.000Z");
    const lastActivityAt = new Date(
      now.getTime() - LIVE_ACTIVITY_WINDOW_MS - 1,
    ).toISOString();
    expect(isRecentlyActive(lastActivityAt, now)).toBe(false);
  });
});
