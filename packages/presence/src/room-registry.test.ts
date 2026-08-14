import { describe, expect, test } from "bun:test";
import {
  createPresenceRoomRegistry,
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
