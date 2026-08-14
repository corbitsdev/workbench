import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  connectPresence,
  type PresenceEventSourceLike,
  type PresenceFetch,
  type PresenceStreamEvent,
} from "./client";
import { decodeBase64, encodeBase64 } from "./base64";
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

function fakeFetch(
  calls: { path: string; body: unknown }[],
  joinResponse: unknown = {},
): PresenceFetch {
  return (url, init) => {
    const body = JSON.parse(init.body) as unknown;
    calls.push({ path: url, body });
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(joinResponse),
    });
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

describe("connectPresence: doc sync", () => {
  test("without a `doc` option, no doc.update listener is attached and join is a plain awareness join", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const handle = connectPresence({
      roomUrl: "/rooms/artifact:art_1",
      fetchImpl: fakeFetch(calls, {
        docUpdate: encodeBase64(new Uint8Array()),
      }),
      openEventSource: () => new FakeEventSource(),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/rooms/artifact:art_1/join");
    handle.disconnect();
  });

  test("the join response's docUpdate seeds the local doc", async () => {
    const seedDoc = new Y.Doc();
    seedDoc.getText("content").insert(0, "seeded from server");
    const joinResponse = {
      docUpdate: encodeBase64(Y.encodeStateAsUpdate(seedDoc)),
    };

    const doc = new Y.Doc();
    const handle = connectPresence({
      roomUrl: "/rooms/artifact:art_1",
      fetchImpl: fakeFetch([], joinResponse),
      openEventSource: () => new FakeEventSource(),
      doc,
    });

    // Let the join promise chain settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(doc.getText("content").toString()).toBe("seeded from server");
    handle.disconnect();
  });

  test("a doc.update SSE event applies into the local doc", async () => {
    const remote = new Y.Doc();
    remote.getText("content").insert(0, "from a peer");
    const source = new FakeEventSource();
    const doc = new Y.Doc();

    const handle = connectPresence({
      roomUrl: "/rooms/artifact:art_1",
      fetchImpl: fakeFetch([]),
      openEventSource: () => source,
      doc,
    });

    source.emit(
      "doc.update",
      JSON.stringify({ update: encodeBase64(Y.encodeStateAsUpdate(remote)) }),
    );

    expect(doc.getText("content").toString()).toBe("from a peer");
    handle.disconnect();
  });

  test("a local doc edit is posted to the room's /update endpoint", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const doc = new Y.Doc();
    const handle = connectPresence({
      roomUrl: "/rooms/artifact:art_1",
      fetchImpl: fakeFetch(calls),
      openEventSource: () => new FakeEventSource(),
      doc,
    });
    calls.length = 0; // drop the initial join call

    doc.getText("content").insert(0, "typed locally");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/rooms/artifact:art_1/update");
    const posted = new Y.Doc();
    Y.applyUpdate(
      posted,
      decodeBase64((calls[0]?.body as { update: string }).update),
    );
    expect(posted.getText("content").toString()).toBe("typed locally");
    handle.disconnect();
  });

  test("applying a remote doc.update does not echo back as a local /update post", () => {
    const remote = new Y.Doc();
    remote.getText("content").insert(0, "remote text");
    const source = new FakeEventSource();
    const calls: { path: string; body: unknown }[] = [];
    const doc = new Y.Doc();

    const handle = connectPresence({
      roomUrl: "/rooms/artifact:art_1",
      fetchImpl: fakeFetch(calls),
      openEventSource: () => source,
      doc,
    });
    calls.length = 0;

    source.emit(
      "doc.update",
      JSON.stringify({ update: encodeBase64(Y.encodeStateAsUpdate(remote)) }),
    );

    expect(calls.filter((c) => c.path.endsWith("/update"))).toHaveLength(0);
    handle.disconnect();
  });

  test("disconnect detaches the doc update listener: further local edits are not posted", () => {
    const calls: { path: string; body: unknown }[] = [];
    const doc = new Y.Doc();
    const handle = connectPresence({
      roomUrl: "/rooms/artifact:art_1",
      fetchImpl: fakeFetch(calls),
      openEventSource: () => new FakeEventSource(),
      doc,
    });
    handle.disconnect();
    calls.length = 0;

    doc.getText("content").insert(0, "after disconnect");

    expect(calls).toEqual([]);
  });

  test("a doc.saved SSE event calls onSaved with the version and timestamp", () => {
    const source = new FakeEventSource();
    const saved: { version: number; savedAt: number }[] = [];
    const handle = connectPresence({
      roomUrl: "/rooms/artifact:art_1",
      fetchImpl: fakeFetch([]),
      openEventSource: () => source,
      onSaved: (info) => saved.push(info),
    });

    source.emit("doc.saved", JSON.stringify({ version: 12, savedAt: 1700 }));

    expect(saved).toEqual([{ version: 12, savedAt: 1700 }]);
    handle.disconnect();
  });

  test("a malformed doc.saved payload is dropped rather than calling onSaved with garbage", () => {
    const source = new FakeEventSource();
    const saved: unknown[] = [];
    const handle = connectPresence({
      roomUrl: "/rooms/artifact:art_1",
      fetchImpl: fakeFetch([]),
      openEventSource: () => source,
      onSaved: (info) => saved.push(info),
    });

    source.emit("doc.saved", "not json");
    source.emit("doc.saved", JSON.stringify({ version: "12" }));

    expect(saved).toEqual([]);
    handle.disconnect();
  });
});
