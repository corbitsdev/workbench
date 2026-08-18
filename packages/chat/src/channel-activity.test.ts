import { describe, expect, test } from "bun:test";
import {
  isRecentlyActive,
  LIVE_ACTIVITY_WINDOW_MS,
  summarizeChannelActivity,
} from "./channel-activity";

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

describe("summarizeChannelActivity", () => {
  test("merges latest-message and unread-count aggregates by channel", () => {
    const channelSessionIds = new Map([
      ["ch_general", "sess_1"],
      ["ch_random", "sess_2"],
    ]);
    const result = summarizeChannelActivity(
      channelSessionIds,
      [
        { sessionId: "sess_1", lastActivityAt: "2026-01-01T00:05:00.000Z" },
        { sessionId: "sess_2", lastActivityAt: "2026-01-01T00:01:00.000Z" },
      ],
      [{ sessionId: "sess_1", unreadCount: 3 }],
    );

    expect(result).toEqual({
      ch_general: {
        unreadCount: 3,
        lastActivityAt: "2026-01-01T00:05:00.000Z",
      },
      ch_random: { unreadCount: 0, lastActivityAt: "2026-01-01T00:01:00.000Z" },
    });
  });

  test("a channel with messages but nothing unread reports unreadCount: 0", () => {
    const result = summarizeChannelActivity(
      new Map([["ch_quiet", "sess_1"]]),
      [{ sessionId: "sess_1", lastActivityAt: "2026-01-01T00:00:00.000Z" }],
      [],
    );
    expect(result).toEqual({
      ch_quiet: { unreadCount: 0, lastActivityAt: "2026-01-01T00:00:00.000Z" },
    });
  });

  test("carries a message's preview through when the aggregate has one", () => {
    const result = summarizeChannelActivity(
      new Map([["ch_general", "sess_1"]]),
      [
        {
          sessionId: "sess_1",
          lastActivityAt: "2026-01-01T00:05:00.000Z",
          preview: "See you at the standup",
        },
      ],
      [],
    );
    expect(result).toEqual({
      ch_general: {
        unreadCount: 0,
        lastActivityAt: "2026-01-01T00:05:00.000Z",
        preview: "See you at the standup",
      },
    });
  });

  test("an attachment-only message with an empty preview omits the field rather than an empty string", () => {
    const result = summarizeChannelActivity(
      new Map([["ch_general", "sess_1"]]),
      [
        {
          sessionId: "sess_1",
          lastActivityAt: "2026-01-01T00:05:00.000Z",
          preview: "",
        },
      ],
      [],
    );
    expect(result).toEqual({
      ch_general: { unreadCount: 0, lastActivityAt: "2026-01-01T00:05:00.000Z" },
    });
  });

  test("a channel with no messages yet reports unreadCount: 0 and no lastActivityAt", () => {
    const result = summarizeChannelActivity(
      new Map([["ch_new", "sess_1"]]),
      [],
      [],
    );
    expect(result).toEqual({ ch_new: { unreadCount: 0 } });
  });

  test("a channel absent from the resolved session map never appears in the result", () => {
    const result = summarizeChannelActivity(new Map(), [], []);
    expect(result).toEqual({});
  });
});
