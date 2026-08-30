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

/** Drains pending microtasks — generous rather than an exact tick count,
 * matching `artifact-persistence.test.ts`'s helper of the same name. */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe("createPresenceRoomRegistry: doc sync", () => {
  const docKey: PresenceRoomKey = {
    tenantId: "tnt_a",
    surface: "artifact:art_1",
  };

  test("concurrent inserts from two clients both land in the server's doc", () => {
    const registry = createPresenceRoomRegistry();
    registry.join(docKey, state("prn_alice"));
    registry.join(docKey, state("prn_bob"));
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
    registry.join(docKey, state("prn_alice"));
    const alice = clientDoc();
    alice.getText("content").insert(0, "already written");
    registry.applyDocUpdate(docKey, Y.encodeStateAsUpdate(alice), "prn_alice");

    const lateJoiner = clientDoc();
    Y.applyUpdate(lateJoiner, registry.docStateAsUpdate(docKey));

    expect(lateJoiner.getText("content").toString()).toBe("already written");
  });

  test("applyDocUpdate notifies both the room-scoped and global doc-change listeners", () => {
    const registry = createPresenceRoomRegistry();
    registry.join(docKey, state("prn_alice"));
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

  test("applyDocUpdate rejects an update for a room nobody currently holds open", () => {
    const registry = createPresenceRoomRegistry();
    const alice = clientDoc();
    alice.getText("content").insert(0, "never joined");

    expect(() =>
      registry.applyDocUpdate(
        docKey,
        Y.encodeStateAsUpdate(alice),
        "prn_alice",
      ),
    ).toThrow();
    expect(registry.docText(docKey)).toBe("");
  });

  test("a zombie update arriving after the room emptied cannot repopulate the freshly recreated room, and a real rejoin still restores it", () => {
    const registry = createPresenceRoomRegistry();
    const unsubscribe = registry.subscribe(docKey, () => undefined);
    registry.join(docKey, state("prn_alice"));
    registry.applyDocUpdate(
      docKey,
      Y.encodeStateAsUpdate(clientDoc()),
      "prn_alice",
    );
    registry.leave(docKey, "prn_alice");
    unsubscribe();

    // The room is now torn down. A delayed POST from Alice's now-evicted
    // client — built before she left, delivered after — must not be able
    // to create a fresh, unseeded room out of nothing.
    const zombie = clientDoc();
    zombie.getText("content").insert(0, "zombie content");
    expect(() =>
      registry.applyDocUpdate(
        docKey,
        Y.encodeStateAsUpdate(zombie),
        "prn_alice",
      ),
    ).toThrow();
    expect(registry.docText(docKey)).toBe("");

    // A legitimate rejoin still sees a genuinely empty doc, ready for
    // `seedOnJoin` to restore real content — not silently defeated by the
    // zombie write.
    expect(registry.seedDocText(docKey, "real stored content")).toBe(true);
    expect(registry.docText(docKey)).toBe("real stored content");
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
    registry.onEmpty((key) => {
      emptied.push(key);
    });

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

describe("createPresenceRoomRegistry: deferred destroy", () => {
  const docKey: PresenceRoomKey = {
    tenantId: "tnt_a",
    surface: "artifact:art_1",
  };

  test("a rejoin before a pending onEmpty flush settles cancels the deferred destroy without losing content", async () => {
    const registry = createPresenceRoomRegistry();
    let resolveFlush: (() => void) | undefined;
    registry.onEmpty(
      () =>
        new Promise<void>((resolve) => {
          resolveFlush = resolve;
        }),
    );

    registry.seedDocText(docKey, "unsaved content");
    const unsubscribe = registry.subscribe(docKey, () => undefined);
    registry.join(docKey, state("prn_alice"));
    registry.leave(docKey, "prn_alice");
    unsubscribe(); // room now empty; destroy deferred on the pending flush

    // Bob joins before the flush resolves.
    registry.join(docKey, state("prn_bob"));
    expect(registry.docText(docKey)).toBe("unsaved content");

    resolveFlush?.();
    await flushMicrotasks();

    // The doc must still be intact — the deferred destroy must not have
    // fired against a room that came back to life while it waited.
    expect(registry.docText(docKey)).toBe("unsaved content");
  });

  test("a doc update landing on a room while its flush is pending gets its own flush, never silently destroyed with it", async () => {
    const registry = createPresenceRoomRegistry();
    const flushedContents: string[] = [];
    let resolveFirstFlush: (() => void) | undefined;
    let flushCount = 0;
    registry.onEmpty((key) => {
      flushCount += 1;
      flushedContents.push(registry.docText(key));
      if (flushCount === 1) {
        return new Promise<void>((resolve) => {
          resolveFirstFlush = resolve;
        });
      }
      return undefined;
    });

    registry.seedDocText(docKey, "first content");
    const unsubscribe = registry.subscribe(docKey, () => undefined);
    registry.join(docKey, state("prn_alice"));
    registry.leave(docKey, "prn_alice");
    unsubscribe(); // flush #1 dispatched and pending

    // A doc update lands on the still-live (pending-destroy) room before
    // the first flush resolves.
    const alice = clientDoc();
    alice.getText("content").insert(0, "second content");
    registry.applyDocUpdate(
      docKey,
      Y.encodeStateAsUpdate(alice),
      "prn_alice",
    );

    resolveFirstFlush?.();
    await flushMicrotasks();

    // The second write must have triggered its own flush dispatch instead
    // of being silently dropped once the room was eventually destroyed.
    expect(flushCount).toBe(2);
    expect(flushedContents[1]).toContain("second content");
  });

  test("a rejoin/edit/leave cycle happening entirely inside a pending flush window is not lost", async () => {
    const registry = createPresenceRoomRegistry();
    const flushedContents: string[] = [];
    const resolvers: (() => void)[] = [];
    registry.onEmpty((key) => {
      flushedContents.push(registry.docText(key));
      return new Promise<void>((resolve) => resolvers.push(resolve));
    });

    registry.seedDocText(docKey, "first content");
    const unsubscribeAlice = registry.subscribe(docKey, () => undefined);
    registry.join(docKey, state("prn_alice"));
    registry.leave(docKey, "prn_alice");
    unsubscribeAlice(); // flush #1 dispatched and pending

    // Bob joins, edits, and leaves entirely within the first flush's
    // pending window.
    const unsubscribeBob = registry.subscribe(docKey, () => undefined);
    registry.join(docKey, state("prn_bob"));
    const bob = clientDoc();
    bob.getText("content").insert(0, "bob's edit");
    registry.applyDocUpdate(docKey, Y.encodeStateAsUpdate(bob), "prn_bob");
    registry.leave(docKey, "prn_bob");
    unsubscribeBob();

    resolvers[0]?.();
    await flushMicrotasks();

    // Settling the first flush must not destroy the doc out from under
    // Bob's session — it must trigger a second flush that actually sees
    // Bob's content, not silently discard it. And that second flush must
    // see it on the *same* doc Alice's flush already captured — proven by
    // both her content and Bob's showing up together, not a doc that got
    // destroyed-and-recreated fresh (losing "first content") in between.
    expect(flushedContents.length).toBe(2);
    expect(flushedContents[1]).toContain("first content");
    expect(flushedContents[1]).toContain("bob's edit");

    resolvers[1]?.();
    await flushMicrotasks();
  });
});
