// Pure-logic tests for the who's-here roster's state machine (CL-6328):
// `nextPresenceRoster` is what `useWorkbenchPresenceRoster` calls on every
// stream event, kept separate so the rule is testable without mounting
// anything — mirrors `typing-indicator.tsx`'s own pure/stateful split.

import { describe, expect, test } from "bun:test";
import {
  nextPresenceRoster,
  parsePresenceEvent,
  parsePresenceSnapshotEvent,
} from "../src/workbench-presence";

describe("parsePresenceEvent", () => {
  test("parses a well-formed chat.presence payload", () => {
    expect(
      parsePresenceEvent({
        principalId: "prn_alice",
        state: "online",
        lastActiveAt: "2026-01-01T00:00:00Z",
      }),
    ).toEqual({
      principalId: "prn_alice",
      state: "online",
      lastActiveAt: "2026-01-01T00:00:00Z",
    });
  });

  test("rejects a malformed payload rather than crashing", () => {
    expect(parsePresenceEvent(null)).toBeNull();
    expect(parsePresenceEvent({})).toBeNull();
    expect(parsePresenceEvent({ principalId: "x", state: "away" })).toBeNull();
  });
});

describe("parsePresenceSnapshotEvent", () => {
  test("parses a well-formed roster", () => {
    expect(
      parsePresenceSnapshotEvent({
        members: [
          { principalId: "prn_alice", lastActiveAt: "2026-01-01T00:00:00Z" },
        ],
      }),
    ).toEqual([{ principalId: "prn_alice", lastActiveAt: "2026-01-01T00:00:00Z" }]);
  });

  test("rejects a malformed roster rather than crashing", () => {
    expect(parsePresenceSnapshotEvent({ members: "nope" })).toBeNull();
    expect(
      parsePresenceSnapshotEvent({ members: [{ principalId: "x" }] }),
    ).toBeNull();
  });
});

describe("nextPresenceRoster", () => {
  test("a snapshot replaces the roster outright", () => {
    const current = [{ principalId: "prn_stale", lastActiveAt: "t0" }];
    const next = nextPresenceRoster(current, {
      eventType: "chat.presence.snapshot",
      data: {
        members: [{ principalId: "prn_alice", lastActiveAt: "t1" }],
      },
    });
    expect(next).toEqual([{ principalId: "prn_alice", lastActiveAt: "t1" }]);
  });

  test("an online delta for a new principal appends them", () => {
    const next = nextPresenceRoster([], {
      eventType: "chat.presence",
      data: { principalId: "prn_alice", state: "online", lastActiveAt: "t1" },
    });
    expect(next).toEqual([{ principalId: "prn_alice", lastActiveAt: "t1" }]);
  });

  test("an online delta for an already-present principal refreshes lastActiveAt in place", () => {
    const current = [{ principalId: "prn_alice", lastActiveAt: "t1" }];
    const next = nextPresenceRoster(current, {
      eventType: "chat.presence",
      data: { principalId: "prn_alice", state: "online", lastActiveAt: "t2" },
    });
    expect(next).toEqual([{ principalId: "prn_alice", lastActiveAt: "t2" }]);
  });

  test("an offline delta drops the principal", () => {
    const current = [
      { principalId: "prn_alice", lastActiveAt: "t1" },
      { principalId: "prn_bob", lastActiveAt: "t1" },
    ];
    const next = nextPresenceRoster(current, {
      eventType: "chat.presence",
      data: { principalId: "prn_alice", state: "offline", lastActiveAt: "t2" },
    });
    expect(next).toEqual([{ principalId: "prn_bob", lastActiveAt: "t1" }]);
  });

  test("any other event type leaves the roster untouched", () => {
    const current = [{ principalId: "prn_alice", lastActiveAt: "t1" }];
    expect(
      nextPresenceRoster(current, { eventType: "chat.typing", data: {} }),
    ).toBe(current);
  });

  test("a malformed delta leaves the roster untouched", () => {
    const current = [{ principalId: "prn_alice", lastActiveAt: "t1" }];
    expect(
      nextPresenceRoster(current, { eventType: "chat.presence", data: null }),
    ).toBe(current);
  });
});
