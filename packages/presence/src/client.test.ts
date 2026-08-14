import { describe, expect, test } from "bun:test";
import {
  connectPresence,
  type PresenceEventSourceLike,
  type PresenceFetch,
  type PresenceStreamEvent,
} from "./client";
import type { PresenceState } from "./room-registry";

class FakeEventSource implements PresenceEventSourceLike {
  private readonly listeners = new Map<
    string,
    Set<(event: PresenceStreamEvent) => void>
  >();
  closed = false;

  addEventListener(
    type: string,
    listener: (event: PresenceStreamEvent) => void,
  ): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data });
    }
  }
}

function fakeFetch(calls: { path: string; body: unknown }[]): PresenceFetch {
  return (url, init) => {
    const body = JSON.parse(init.body) as unknown;
    calls.push({ path: url, body });
    return Promise.resolve({ ok: true });
  };
}

describe("connectPresence", () => {
  test("joins immediately and opens the room's SSE stream", () => {
    const calls: { path: string; body: unknown }[] = [];
    let openedUrl = "";
    const source = new FakeEventSource();

    const handle = connectPresence({
      roomUrl: "/api/tenants/tnt_1/presence/rooms/channel:chn_1",
      displayName: "Alice",
      fetchImpl: fakeFetch(calls),
      openEventSource: (url) => {
        openedUrl = url;
        return source;
      },
    });

    expect(openedUrl).toBe(
      "/api/tenants/tnt_1/presence/rooms/channel:chn_1/stream",
    );
    expect(calls[0]?.path).toBe(
      "/api/tenants/tnt_1/presence/rooms/channel:chn_1/join",
    );
    expect(calls[0]?.body).toEqual({ displayName: "Alice" });
    handle.disconnect();
  });

  test("subscribers receive every snapshot the stream emits", () => {
    const source = new FakeEventSource();
    const handle = connectPresence({
      roomUrl: "/rooms/channel:chn_1",
      fetchImpl: fakeFetch([]),
      openEventSource: () => source,
    });

    const received: (readonly PresenceState[])[] = [];
    handle.subscribe((members) => received.push(members));

    const members: PresenceState[] = [
      {
        principalId: "prn_alice",
        displayName: "Alice",
        color: "hsl(0 65% 45%)",
      },
    ];
    source.emit("presence.state", JSON.stringify(members));

    expect(received).toHaveLength(2); // initial empty snapshot, then the emitted one
    expect(received[1]).toEqual(members);
    handle.disconnect();
  });

  test("publishCursor and publishTyping post heartbeats with the patch", () => {
    const calls: { path: string; body: unknown }[] = [];
    const handle = connectPresence({
      roomUrl: "/rooms/channel:chn_1",
      fetchImpl: fakeFetch(calls),
      openEventSource: () => new FakeEventSource(),
    });
    calls.length = 0; // drop the initial join call

    handle.publishCursor({ x: 5, y: 6, surfaceVersion: 1 });
    handle.publishTyping(true);

    expect(calls).toEqual([
      {
        path: "/rooms/channel:chn_1/heartbeat",
        body: { cursor: { x: 5, y: 6, surfaceVersion: 1 } },
      },
      { path: "/rooms/channel:chn_1/heartbeat", body: { typing: true } },
    ]);
    handle.disconnect();
  });

  test("disconnect closes the stream and posts leave, and further publishes are no-ops", () => {
    const calls: { path: string; body: unknown }[] = [];
    const source = new FakeEventSource();
    const handle = connectPresence({
      roomUrl: "/rooms/channel:chn_1",
      fetchImpl: fakeFetch(calls),
      openEventSource: () => source,
    });
    calls.length = 0;

    handle.disconnect();

    expect(source.closed).toBe(true);
    expect(calls).toEqual([{ path: "/rooms/channel:chn_1/leave", body: {} }]);

    calls.length = 0;
    handle.publishCursor({ x: 1, y: 1, surfaceVersion: 1 });
    expect(calls).toEqual([]);
  });
});
