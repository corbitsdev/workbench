import { describe, expect, test } from "bun:test";
import { createExpiringMap } from "./expiring-map";

/** A controllable clock: advances only when the test tells it to, so
 * sweep and expiry timing is asserted exactly rather than raced against
 * a real timer. */
function fakeClock(startAt = 0) {
  let now = startAt;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("createExpiringMap", () => {
  test("returns a value before its ttl elapses", () => {
    const clock = fakeClock();
    const map = createExpiringMap<string, number>({
      ttlMs: 1_000,
      now: clock.now,
    });

    map.set("a", 1);
    clock.advance(999);

    expect(map.get("a")).toBe(1);
  });

  test("drops a value once its ttl elapses, without a further sweep or set", () => {
    const clock = fakeClock();
    const map = createExpiringMap<string, number>({
      ttlMs: 1_000,
      now: clock.now,
    });

    map.set("a", 1);
    clock.advance(1_000);

    expect(map.get("a")).toBeUndefined();
  });

  test("size reflects the lazy expiry a get() just performed", () => {
    const clock = fakeClock();
    const map = createExpiringMap<string, number>({
      ttlMs: 1_000,
      now: clock.now,
    });

    map.set("a", 1);
    clock.advance(1_000);
    expect(map.get("a")).toBeUndefined();

    expect(map.size).toBe(0);
  });

  test("a fresh set on an existing key resets its ttl", () => {
    const clock = fakeClock();
    const map = createExpiringMap<string, number>({
      ttlMs: 1_000,
      now: clock.now,
    });

    map.set("a", 1);
    clock.advance(600);
    map.set("a", 2);
    clock.advance(600);

    // 1200ms since the first set, but only 600ms since the refresh.
    expect(map.get("a")).toBe(2);
  });

  test("delete removes a key outright", () => {
    const map = createExpiringMap<string, number>({ ttlMs: 1_000 });
    map.set("a", 1);

    expect(map.delete("a")).toBe(true);
    expect(map.get("a")).toBeUndefined();
    expect(map.delete("a")).toBe(false);
  });

  test("a set-triggered sweep clears every expired key, not just the one being set", () => {
    const clock = fakeClock();
    const map = createExpiringMap<string, number>({
      ttlMs: 1_000,
      now: clock.now,
    });

    map.set("a", 1);
    map.set("b", 2);
    clock.advance(1_000);
    // Neither "a" nor "b" has been read since expiring, so nothing has
    // lazily dropped them yet — only the sweep this set triggers does.
    map.set("c", 3);

    expect(map.size).toBe(1);
    expect(map.get("c")).toBe(3);
  });

  test("a set before the sweep interval elapses does not sweep other expired entries early", () => {
    const clock = fakeClock();
    const map = createExpiringMap<string, number>({
      ttlMs: 1_000,
      now: clock.now,
    });

    map.set("a", 1);
    clock.advance(1_000);
    map.set("b", 2);
    // The sweep triggered by setting "b" cleared "a"; "b" itself is
    // fresh and must survive a set that happens well within its own ttl.
    clock.advance(1);
    map.set("c", 3);

    expect(map.get("b")).toBe(2);
    expect(map.get("c")).toBe(3);
  });

  test("many distinct keys within one ttl window do not grow past the window's own traffic once it passes", () => {
    const clock = fakeClock();
    const map = createExpiringMap<string, number>({
      ttlMs: 1_000,
      now: clock.now,
    });

    for (let i = 0; i < 500; i += 1) map.set(`user_${i}`, i);
    expect(map.size).toBe(500);

    clock.advance(1_000);
    // A single new key's set sweeps the whole prior window away.
    map.set("user_new", 1);

    expect(map.size).toBe(1);
  });
});
