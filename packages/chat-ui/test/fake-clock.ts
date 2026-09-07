// A synchronous stand-in for `../src/clock.ts`'s `REAL_CLOCK`: `advance`
// fires every due timer against a virtual clock with no real sleep, so a
// test asserting a 30ms backstop actually fired takes 0ms of wall time
// instead of racing CI's CPU-contended shards for those 30ms (CL-7488).
import type { Clock } from "../src/clock";

export type FakeClock = {
  readonly clock: Clock;
  /** Moves the virtual clock forward by `ms`, firing (in fire-time order)
   * every timer due at or before the new time — including one a firing
   * timer's own callback re-arms within this same window, mirroring how a
   * real timer queue drains. */
  readonly advance: (ms: number) => void;
};

export function createFakeClock(): FakeClock {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { fireAt: number; callback: () => void }>();

  function fakeSetTimeout(callback: () => void, ms: number): number {
    const id = nextId++;
    timers.set(id, { fireAt: now + ms, callback });
    return id;
  }

  function fakeClearTimeout(handle: unknown): void {
    timers.delete(handle as number);
  }

  function advance(ms: number): void {
    const target = now + ms;
    for (;;) {
      let dueId: number | null = null;
      let dueEntry: { fireAt: number; callback: () => void } | null = null;
      for (const [id, entry] of timers) {
        if (
          entry.fireAt <= target &&
          (dueEntry === null || entry.fireAt < dueEntry.fireAt)
        ) {
          dueId = id;
          dueEntry = entry;
        }
      }
      if (dueId === null || dueEntry === null) break;
      timers.delete(dueId);
      now = dueEntry.fireAt;
      dueEntry.callback();
    }
    now = target;
  }

  return {
    clock: {
      now: () => now,
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
    },
    advance,
  };
}
