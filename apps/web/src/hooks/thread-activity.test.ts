/// <reference types="bun" />
import "../test-setup";
import { beforeEach, describe, expect, it } from "bun:test";
import {
  markThreadViewed,
  readThreadLastViewedAt,
  threadHasNewActivity,
} from "./thread-activity";

describe("thread-activity", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("reports no activity for a thread never viewed in this browser", () => {
    expect(
      threadHasNewActivity({
        id: "t1",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    ).toBe(false);
    expect(readThreadLastViewedAt("t1")).toBeNull();
  });

  it("reports new activity once lastActivityAt advances past the viewed watermark", () => {
    markThreadViewed("t1", "2026-01-01T00:00:00Z");
    expect(
      threadHasNewActivity({
        id: "t1",
        lastActivityAt: "2026-01-01T00:05:00Z",
      }),
    ).toBe(true);
  });

  it("reports no new activity once the watermark catches up to lastActivityAt", () => {
    markThreadViewed("t1", "2026-01-01T00:05:00Z");
    expect(
      threadHasNewActivity({
        id: "t1",
        lastActivityAt: "2026-01-01T00:05:00Z",
      }),
    ).toBe(false);
  });

  it("scopes the watermark per thread id", () => {
    markThreadViewed("t1", "2026-01-01T00:05:00Z");
    expect(
      threadHasNewActivity({
        id: "t2",
        lastActivityAt: "2026-01-01T00:01:00Z",
      }),
    ).toBe(false);
    expect(readThreadLastViewedAt("t2")).toBeNull();
  });
});
