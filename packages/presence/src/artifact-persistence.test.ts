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

  test("debounces: rapid edits within the quiet window snapshot only once", () => {
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
    expect(writes).toHaveLength(1);
    expect(writes[0]?.author).toBe("prn_alice");
  });

  test("flushes immediately (bypassing debounce) when the room empties", () => {
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

    registry.applyDocUpdate(key, docUpdateInserting("final edit"), "prn_bob");

    const unsubscribe = registry.subscribe(key, () => undefined);
    registry.join(key, {
      principalId: "prn_bob",
      displayName: "Bob",
      color: "hsl(0 65% 45%)",
    });
    registry.leave(key, "prn_bob");
    unsubscribe();

    // No need to advance the fake clock at all — leaving flushed synchronously.
    expect(writes).toEqual(["final edit"]);
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

    registry.applyDocUpdate(key, docUpdateInserting("x"), "prn_alice");

    clock.advance(3_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
  });
});
