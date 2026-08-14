import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  createPresenceRoomRegistry,
  type PresenceRoomKey,
  type PresenceState,
} from "./room-registry";

const key = { tenantId: "tnt_a", surface: "channel:chn_1" };

function state(principalId: string): PresenceState {
  return { principalId, displayName: principalId, color: "hsl(0 65% 45%)" };
}

describe("createPresenceRoomRegistry", () => {
  test("two clients joining the same room each see the other's awareness", () => {
    const registry = createPresenceRoomRegistry();
    const seenByAlice: (readonly PresenceState[])[] = [];
    const seenByBob: (readonly PresenceState[])[] = [];

    registry.subscribe(key, (states) => seenByAlice.push(states));
    registry.join(key, state("prn_alice"));
    registry.subscribe(key, (states) => seenByBob.push(states));
    registry.join(key, state("prn_bob"));

    const finalAlice = seenByAlice[seenByAlice.length - 1] ?? [];
    const finalBob = seenByBob[seenByBob.length - 1] ?? [];
    expect(finalAlice.map((s) => s.principalId).sort()).toEqual([
      "prn_alice",
      "prn_bob",
    ]);
    expect(finalBob.map((s) => s.principalId).sort()).toEqual([
      "prn_alice",
      "prn_bob",
    ]);
  });

  test("heartbeat patches cursor/typing on top of the existing state", () => {
    const registry = createPresenceRoomRegistry();
    registry.join(key, state("prn_alice"));

    const result = registry.heartbeat(key, "prn_alice", {
      cursor: { x: 10, y: 20, surfaceVersion: 1 },
      typing: true,
    });

    expect(result).toBeDefined();
    const alice = result?.find((s) => s.principalId === "prn_alice");
    expect(alice?.cursor).toEqual({ x: 10, y: 20, surfaceVersion: 1 });
    expect(alice?.typing).toBe(true);
    expect(alice?.displayName).toBe("prn_alice");
  });

  test("heartbeat for a principal who never joined returns undefined", () => {
    const registry = createPresenceRoomRegistry();
    expect(registry.heartbeat(key, "prn_ghost", {})).toBeUndefined();
  });

  test("leave removes the principal and notifies remaining subscribers", () => {
    const registry = createPresenceRoomRegistry();
    const seen: (readonly PresenceState[])[] = [];
    registry.join(key, state("prn_alice"));
    registry.join(key, state("prn_bob"));
    registry.subscribe(key, (states) => seen.push(states));

    registry.leave(key, "prn_alice");

    const last = seen[seen.length - 1] ?? [];
    expect(last.map((s) => s.principalId)).toEqual(["prn_bob"]);
  });

  test("heartbeat timeout drops a client from the room", () => {
    const registry = createPresenceRoomRegistry();
    let now = 1_000_000;
    registry.join(key, state("prn_alice"), now);
    registry.join(key, state("prn_bob"), now);

    // Only bob heartbeats; alice goes quiet.
    now += 20_000;
    registry.heartbeat(key, "prn_bob", {}, now);

    now += 30_000; // alice's last heartbeat is now 50s stale
    registry.sweepStale(45_000, now);

    const remaining = registry.states(key);
    expect(remaining.map((s) => s.principalId)).toEqual(["prn_bob"]);
  });

  test("a dropped client's heartbeat after timeout returns undefined until it rejoins", () => {
    const registry = createPresenceRoomRegistry();
    let now = 0;
    registry.join(key, state("prn_alice"), now);
    now += 100_000;
    registry.sweepStale(45_000, now);

    expect(registry.heartbeat(key, "prn_alice", {}, now)).toBeUndefined();

    const rejoined = registry.join(key, state("prn_alice"), now);
    expect(rejoined.map((s) => s.principalId)).toEqual(["prn_alice"]);
  });

  test("tenant isolation: a room key for tenant A never sees tenant B's members", () => {
    const registry = createPresenceRoomRegistry();
    const keyA = { tenantId: "tnt_a", surface: "channel:chn_1" };
    const keyB = { tenantId: "tnt_b", surface: "channel:chn_1" };

    registry.join(keyA, state("prn_alice"));
    registry.join(keyB, state("prn_bob"));

    expect(registry.states(keyA).map((s) => s.principalId)).toEqual([
      "prn_alice",
    ]);
    expect(registry.states(keyB).map((s) => s.principalId)).toEqual([
      "prn_bob",
    ]);
  });

  test("a room with no members and no subscribers is torn down (no leaked timers)", () => {
    const registry = createPresenceRoomRegistry();
    const unsubscribe = registry.subscribe(key, () => undefined);
    registry.join(key, state("prn_alice"));
    registry.leave(key, "prn_alice");
    unsubscribe();

    // A fresh join after full teardown must produce a brand new room, not
    // reuse stale awareness state from the destroyed one.
    const snapshot = registry.join(key, state("prn_bob"));
    expect(snapshot.map((s) => s.principalId)).toEqual(["prn_bob"]);
  });
});

/** Two independent `Y.Doc`s, standing in for two browser tabs, that only
 * ever talk to each other through a registry's `applyDocUpdate`/
 * `docStateAsUpdate` — the same seam the HTTP routes use. */
function clientDoc(): Y.Doc {
  return new Y.Doc();
}

describe("createPresenceRoomRegistry: doc sync", () => {
  const docKey: PresenceRoomKey = {
    tenantId: "tnt_a",
    surface: "artifact:art_1",
  };

  test("concurrent inserts from two clients both land in the server's doc", () => {
    const registry = createPresenceRoomRegistry();
    const alice = clientDoc();
    const bob = clientDoc();
    alice.getText("content").insert(0, "hello");
    bob.getText("content").insert(0, "world");

    registry.applyDocUpdate(docKey, Y.encodeStateAsUpdate(alice), "prn_alice");
    registry.applyDocUpdate(docKey, Y.encodeStateAsUpdate(bob), "prn_bob");

    const merged = new Y.Doc();
    Y.applyUpdate(merged, registry.docStateAsUpdate(docKey));
    const text = merged.getText("content").toString();
    expect(text).toContain("hello");
    expect(text).toContain("world");
    expect(registry.docText(docKey)).toBe(text);
  });

  test("a late joiner catches up to the full doc state via docStateAsUpdate", () => {
    const registry = createPresenceRoomRegistry();
    const alice = clientDoc();
    alice.getText("content").insert(0, "already written");
    registry.applyDocUpdate(docKey, Y.encodeStateAsUpdate(alice), "prn_alice");

    const lateJoiner = clientDoc();
    Y.applyUpdate(lateJoiner, registry.docStateAsUpdate(docKey));

    expect(lateJoiner.getText("content").toString()).toBe("already written");
  });

  test("applyDocUpdate notifies both the room-scoped and global doc-change listeners", () => {
    const registry = createPresenceRoomRegistry();
    const roomUpdates: string[] = [];
    const globalChanges: { key: PresenceRoomKey; author: string }[] = [];
    registry.subscribeDocUpdates(docKey, (_update, author) =>
      roomUpdates.push(author),
    );
    registry.onDocChange((key, author) => globalChanges.push({ key, author }));

    const alice = clientDoc();
    alice.getText("content").insert(0, "x");
    registry.applyDocUpdate(docKey, Y.encodeStateAsUpdate(alice), "prn_alice");

    expect(roomUpdates).toEqual(["prn_alice"]);
    expect(globalChanges).toEqual([{ key: docKey, author: "prn_alice" }]);
  });

  test("seedDocText only seeds an empty doc, never clobbering real content", () => {
    const registry = createPresenceRoomRegistry();
    expect(registry.seedDocText(docKey, "seeded")).toBe(true);
    expect(registry.docText(docKey)).toBe("seeded");

    expect(registry.seedDocText(docKey, "different")).toBe(false);
    expect(registry.docText(docKey)).toBe("seeded");
  });

  test("onEmpty fires when a room with doc content is torn down", () => {
    const registry = createPresenceRoomRegistry();
    const emptied: PresenceRoomKey[] = [];
    registry.onEmpty((key) => emptied.push(key));

    registry.seedDocText(docKey, "content before anyone joins");
    const unsubscribe = registry.subscribe(docKey, () => undefined);
    registry.join(docKey, state("prn_alice"));
    registry.leave(docKey, "prn_alice");
    unsubscribe();

    expect(emptied).toContainEqual(docKey);
  });

  test("docStateAsUpdate for a room that was never created is a valid empty-doc update", () => {
    const registry = createPresenceRoomRegistry();
    const neverCreated: PresenceRoomKey = {
      tenantId: "tnt_a",
      surface: "artifact:never_touched",
    };
    const doc = new Y.Doc();
    expect(() =>
      Y.applyUpdate(doc, registry.docStateAsUpdate(neverCreated)),
    ).not.toThrow();
    expect(doc.getText("content").toString()).toBe("");
  });

  test("notifySnapshot fans out to every subscriber for that room, not other rooms", () => {
    const registry = createPresenceRoomRegistry();
    const otherKey: PresenceRoomKey = {
      tenantId: "tnt_a",
      surface: "artifact:art_2",
    };
    const seen: { version: number; savedAt: number }[] = [];
    const seenOther: unknown[] = [];
    registry.subscribeSnapshots(docKey, (info) => seen.push(info));
    registry.subscribeSnapshots(otherKey, (info) => seenOther.push(info));

    registry.notifySnapshot(docKey, { version: 3, savedAt: 12345 });

    expect(seen).toEqual([{ version: 3, savedAt: 12345 }]);
    expect(seenOther).toEqual([]);
  });

  test("unsubscribing from snapshot notifications stops further delivery", () => {
    const registry = createPresenceRoomRegistry();
    const seen: unknown[] = [];
    const unsubscribe = registry.subscribeSnapshots(docKey, (info) =>
      seen.push(info),
    );
    unsubscribe();

    registry.notifySnapshot(docKey, { version: 1, savedAt: 1 });

    expect(seen).toEqual([]);
  });
});
