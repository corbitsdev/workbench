/**
 * Deterministic setTimeout/setInterval for tests. Install per test, drive with
 * `advance(ms)` (wrap in `act` when timers update React state), `restore()` in
 * teardown.
 */
export interface FakeTimers {
  advance(ms: number): void;
  restore(): void;
}

type TimerEntry = {
  id: number;
  at: number;
  ms: number;
  repeat: boolean;
  fn: () => void;
};

export function installFakeTimers(): FakeTimers {
  let now = 0;
  let seq = 0;
  const timers: TimerEntry[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;

  const schedule = (fn: () => void, ms: number, repeat: boolean) => {
    const id = ++seq;
    timers.push({ id, at: now + ms, ms, repeat, fn });
    return id as unknown as ReturnType<typeof realSetTimeout>;
  };

  const clearById = (id?: number) => {
    if (id === undefined) return;
    const index = timers.findIndex((t) => t.id === id);
    if (index >= 0) timers.splice(index, 1);
  };

  globalThis.setTimeout = ((fn: () => void, ms = 0) =>
    schedule(fn, ms, false)) as typeof setTimeout;
  globalThis.clearTimeout = clearById as typeof clearTimeout;
  globalThis.setInterval = ((fn: () => void, ms = 0) =>
    schedule(fn, ms, true)) as typeof setInterval;
  globalThis.clearInterval = clearById as typeof clearInterval;

  const fireDue = () => {
    const due = timers
      .filter((t) => t.at <= now)
      .sort((a, b) => a.at - b.at || a.id - b.id);
    for (const timer of due) {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
      if (timer.repeat) {
        timer.at = now + timer.ms;
        timers.push(timer);
      }
      timer.fn();
    }
  };

  return {
    advance(ms) {
      const target = now + ms;
      while (true) {
        const nextAt = timers.reduce<number | null>(
          (min, t) => (t.at <= target ? (min === null || t.at < min ? t.at : min) : min),
          null,
        );
        if (nextAt === null) {
          now = target;
          return;
        }
        now = nextAt;
        fireDue();
      }
    },
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    },
  };
}