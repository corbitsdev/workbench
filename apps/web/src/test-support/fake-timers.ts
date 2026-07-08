/**
 * A minimal deterministic setTimeout/clearTimeout replacement for tests that
 * need to drive time-based behavior (the reconnecting-overlay debounce) without
 * real waits. Install in a test, drive with `advance(ms)` (wrap it in `act` when
 * the timer triggers React state), and `restore()` in teardown.
 *
 * Scope note: this replaces the global timers for the whole test, so only code
 * whose timers you intend to control should run while it is installed.
 */
export interface FakeTimers {
  advance(ms: number): void;
  restore(): void;
}

export function installFakeTimers(): FakeTimers {
  let now = 0;
  let seq = 0;
  const timers: { id: number; at: number; fn: () => void }[] = [];
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;

  globalThis.setTimeout = ((fn: () => void, ms = 0) => {
    const id = ++seq;
    timers.push({ id, at: now + ms, fn });
    return id as unknown as ReturnType<typeof realSet>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id?: number) => {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  }) as typeof clearTimeout;

  return {
    advance(ms) {
      now += ms;
      for (const t of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
    restore() {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}
