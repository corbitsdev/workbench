import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  artifactIdForSurface,
  createArtifactDocPersistence,
} from "./artifact-persistence";
import { createPresenceRoomRegistry } from "./room-registry";

function docUpdateInserting(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

/** `applyDocUpdate` only accepts updates for a room that already exists —
 * it never auto-creates one (see `room-registry.ts`) — so every test that
 * posts a doc update joins first to open the room, exactly like the real
 * join-then-edit flow the HTTP routes use. */
function joinPrincipal(
  registry: ReturnType<typeof createPresenceRoomRegistry>,
  key: { tenantId: string; surface: string },
  principalId: string,
): void {
  registry.join(key, {
    principalId,
    displayName: principalId,
    color: "hsl(0 65% 45%)",
  });
}

/** Drains pending microtasks — generous rather than an exact tick count,
 * since the write chain's depth (and therefore how many `.then()` hops a
 * test needs to wait out) is an implementation detail these tests
 * shouldn't have to track precisely. */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/** A hand-rolled fake timer: `setTimeoutImpl`/`clearTimeoutImpl` are
 * injected exactly so tests never depend on real wall-clock delay — the
 * same pattern `room-registry.test.ts` uses for `sweepStale`'s `now`. */
function fakeClock() {
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let now = 0;
  return {
    now: () => now,
    setTimeoutImpl: (fn: () => void, ms: number) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeoutImpl: (handle: unknown) => {
      pending.delete(handle as number);
    },
    advance: (ms: number) => {
      now += ms;
      for (const [id, entry] of [...pending.entries()]) {
        if (entry.at <= now) {
          pending.delete(id);
          entry.fn();
        }
      }
    },
    pendingCount: () => pending.size,
  };
}

describe("artifactIdForSurface", () => {
  test("extracts the artifact id from an artifact: surface", () => {
    expect(artifactIdForSurface("artifact:art_1")).toBe("art_1");
  });

  test("returns null for a non-artifact surface", () => {
    expect(artifactIdForSurface("channel:chn_1")).toBeNull();
  });

  test("returns null for a bare 'artifact:' with no id", () => {
    expect(artifactIdForSurface("artifact:")).toBeNull();
  });
});

describe("createArtifactDocPersistence", () => {
  const key = { tenantId: "tnt_a", surface: "artifact:art_1" };

  test("debounces: rapid edits within the quiet window snapshot only once", async () => {
    const registry = createPresenceRoomRegistry();
    const clock = fakeClock();
    const writes: { content: string; author: string }[] = [];
    createArtifactDocPersistence({
      registry,
      debounceMs: 2_000,
      now: clock.now,
      setTimeoutImpl: clock.setTimeoutImpl,
      clearTimeoutImpl: clock.clearTimeoutImpl,
      loadArtifactContent: async () => null,
      writeArtifactSnapshot: async (_t, _a, authorPrincipalId, content) => {
        writes.push({ content, author: authorPrincipalId });
        return { version: writes.length + 1 };
      },
    });

    registry.seedDocText(key, "");
    registry.subscribeDocUpdates(key, () => undefined); // keep the room alive
    joinPrincipal(registry, key, "prn_alice");

    // Simulate three quick edits, each a real Yjs update.
    const edit = (text: string) => {
      registry.applyDocUpdate(key, docUpdateInserting(text), "prn_alice");
    };

    edit("h");
    clock.advance(500);
    edit("he");
    clock.advance(500);
    edit("hel");

    // Still within the 2s quiet window since the last edit — nothing
    // written yet.
    clock.advance(1_000);
    expect(writes).toHaveLength(0);

    // Quiet window elapses with no further edits.
    clock.advance(1_500);
    // The write is enqueued onto a per-room promise chain (see
    // `enqueueSnapshot`) rather than started synchronously, so it needs a
    // microtask tick to actually run.
    await flushMicrotasks();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.author).toBe("prn_alice");
  });

  test("flushes immediately (bypassing debounce) when the room empties", async () => {
    const registry = createPresenceRoomRegistry();
    const clock = fakeClock();
    const writes: string[] = [];
    createArtifactDocPersistence({
      registry,
      debounceMs: 2_000,
      now: clock.now,
      setTimeoutImpl: clock.setTimeoutImpl,
      clearTimeoutImpl: clock.clearTimeoutImpl,
      loadArtifactContent: async () => null,
      writeArtifactSnapshot: async (_t, _a, _author, content) => {
        writes.push(content);
        return { version: 2 };
      },
    });

    const unsubscribe = registry.subscribe(key, () => undefined);
    registry.join(key, {
      principalId: "prn_bob",
      displayName: "Bob",
      color: "hsl(0 65% 45%)",
    });
    registry.applyDocUpdate(key, docUpdateInserting("final edit"), "prn_bob");
    registry.leave(key, "prn_bob");
    unsubscribe();

    // No need to advance the fake clock at all — leaving flushes without
    // waiting out the debounce window, though the write itself still
    // runs a microtask later via the per-room write chain.
    await flushMicrotasks();
    expect(writes).toEqual(["final edit"]);
  });

  test("a post-eviction zombie update cannot pre-empt or block seedOnJoin's content restoration", async () => {
    const registry = createPresenceRoomRegistry();
    const persistence = createArtifactDocPersistence({
      registry,
      loadArtifactContent: async () => "content from storage",
      writeArtifactSnapshot: async () => ({ version: 1 }),
    });

    // Alice joins, edits, and leaves — the room empties and is torn down.
    const unsubscribe = registry.subscribe(key, () => undefined);
    joinPrincipal(registry, key, "prn_alice");
    registry.applyDocUpdate(
      key,
      docUpdateInserting("alice's edit"),
      "prn_alice",
    );
    registry.leave(key, "prn_alice");
    unsubscribe();
    // The room's teardown flush is asynchronous (see room-registry.ts's
    // deferred destroy) — wait for it to actually settle and the room to
    // be gone before simulating a POST arriving after that point.
    await flushMicrotasks();

    // A delayed POST from Alice's now-evicted client lands after the
    // room was destroyed. It must be rejected outright, not silently
    // recreate the room and populate it with stale content.
    expect(() =>
      registry.applyDocUpdate(key, docUpdateInserting("zombie"), "prn_alice"),
    ).toThrow();

    // A legitimate rejoin must still restore the real stored content —
    // the zombie write must not have made the doc look already-seeded.
    await persistence.seedOnJoin(key);
    expect(registry.docText(key)).toBe("content from storage");
  });

  test("never schedules a snapshot for a non-artifact surface", () => {
    const registry = createPresenceRoomRegistry();
    const clock = fakeClock();
    const writes: string[] = [];
    createArtifactDocPersistence({
      registry,
      now: clock.now,
      setTimeoutImpl: clock.setTimeoutImpl,
      clearTimeoutImpl: clock.clearTimeoutImpl,
      loadArtifactContent: async () => null,
      writeArtifactSnapshot: async (_t, _a, _author, content) => {
        writes.push(content);
        return { version: 2 };
      },
    });

    const channelKey = { tenantId: "tnt_a", surface: "channel:chn_1" };
    joinPrincipal(registry, channelKey, "prn_alice");
    registry.applyDocUpdate(
      channelKey,
      docUpdateInserting("not an artifact"),
      "prn_alice",
    );

    clock.advance(10_000);
    expect(writes).toHaveLength(0);
    expect(clock.pendingCount()).toBe(0);
  });

  test("seedOnJoin populates an empty room from the artifact's stored content, once", async () => {
    const registry = createPresenceRoomRegistry();
    let loadCalls = 0;
    const persistence = createArtifactDocPersistence({
      registry,
      loadArtifactContent: async (tenantId, artifactId) => {
        loadCalls += 1;
        expect(tenantId).toBe("tnt_a");
        expect(artifactId).toBe("art_1");
        return "stored artifact body";
      },
      writeArtifactSnapshot: async () => ({ version: 1 }),
    });

    await persistence.seedOnJoin(key);
    expect(registry.docText(key)).toBe("stored artifact body");

    // A second joiner must not re-seed (and must not re-load) — the room
    // already has real content that might have since been edited.
    await persistence.seedOnJoin(key);
    expect(loadCalls).toBe(1);
  });

  test("seedOnJoin is a no-op for a non-artifact surface", async () => {
    const registry = createPresenceRoomRegistry();
    let loadCalls = 0;
    const persistence = createArtifactDocPersistence({
      registry,
      loadArtifactContent: async () => {
        loadCalls += 1;
        return "should never be read";
      },
      writeArtifactSnapshot: async () => ({ version: 1 }),
    });

    await persistence.seedOnJoin({
      tenantId: "tnt_a",
      surface: "channel:chn_1",
    });
    expect(loadCalls).toBe(0);
  });

  test("a successful snapshot notifies the registry so subscribers can render an honest saved-state line", async () => {
    const registry = createPresenceRoomRegistry();
    const clock = fakeClock();
    const notifications: { version: number; savedAt: number }[] = [];
    registry.subscribeSnapshots(key, (info) => notifications.push(info));

    createArtifactDocPersistence({
      registry,
      now: clock.now,
      setTimeoutImpl: clock.setTimeoutImpl,
      clearTimeoutImpl: clock.clearTimeoutImpl,
      loadArtifactContent: async () => null,
      writeArtifactSnapshot: async () => ({ version: 12 }),
    });

    joinPrincipal(registry, key, "prn_alice");
    registry.applyDocUpdate(key, docUpdateInserting("x"), "prn_alice");
    clock.advance(2_100);
    await Promise.resolve();
    await Promise.resolve();

    expect(notifications).toEqual([{ version: 12, savedAt: clock.now() }]);
  });

  test("a snapshot-write failure is reported via onSnapshotError, never thrown into the caller", async () => {
    const registry = createPresenceRoomRegistry();
    const clock = fakeClock();
    const errors: unknown[] = [];
    createArtifactDocPersistence({
      registry,
      now: clock.now,
      setTimeoutImpl: clock.setTimeoutImpl,
      clearTimeoutImpl: clock.clearTimeoutImpl,
      loadArtifactContent: async () => null,
      writeArtifactSnapshot: async () => {
        throw new Error("db unavailable");
      },
      onSnapshotError: (_key, error) => errors.push(error),
    });

    joinPrincipal(registry, key, "prn_alice");
    registry.applyDocUpdate(key, docUpdateInserting("x"), "prn_alice");

    clock.advance(3_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
  });

  // Promoted from the reviewer's tmp/critique-tests/overlap-snapshot.test.ts
  // repro (a slow write #1 resolving after a fast write #2 used to
  // re-notify the stale, lower version — a "Saved v1" regression after
  // "Saved v2" already rendered). Inverted here to assert the fix:
  // per-room write serialization (`enqueueSnapshot`'s promise chain)
  // guarantees writes execute and notify in the order they were
  // scheduled, so versions can never regress.
  test("a slow write and a faster later write never deliver snapshot notifications out of order", async () => {
    const registry = createPresenceRoomRegistry();
    const clock = fakeClock();
    const notifications: { version: number }[] = [];
    registry.subscribeSnapshots(key, (info) => notifications.push(info));

    let callCount = 0;
    const resolvers: (() => void)[] = [];
    createArtifactDocPersistence({
      registry,
      debounceMs: 2_000,
      now: clock.now,
      setTimeoutImpl: clock.setTimeoutImpl,
      clearTimeoutImpl: clock.clearTimeoutImpl,
      loadArtifactContent: async () => null,
      writeArtifactSnapshot: async (_t, _a, _author, _content) => {
        callCount += 1;
        const version = callCount;
        if (version === 1) {
          await new Promise<void>((resolve) => resolvers.push(resolve));
        }
        return { version };
      },
    });

    joinPrincipal(registry, key, "prn_alice");
    registry.applyDocUpdate(key, docUpdateInserting("a"), "prn_alice");
    clock.advance(2_000); // schedules write #1 (slow — awaits its resolver)
    await Promise.resolve();

    registry.applyDocUpdate(key, docUpdateInserting("b"), "prn_alice");
    clock.advance(2_000); // schedules write #2, but it's chained behind #1
    await Promise.resolve();
    await Promise.resolve();

    // Write #1 hasn't resolved yet, so write #2 must not have started —
    // serialization means it can't jump the queue no matter how fast its
    // own mock would resolve.
    expect(callCount).toBe(1);
    expect(notifications).toEqual([]);

    resolvers[0]?.();
    await flushMicrotasks();

    // Both writes landed, strictly in the order they were scheduled —
    // never [2, 1].
    expect(notifications.map((n) => n.version)).toEqual([1, 2]);
  });
});
