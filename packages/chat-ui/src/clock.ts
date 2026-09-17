// The one seam `streaming-reply.ts` and `turn-activity.tsx` read wall-clock
// time and arm backstop timers through, so a test can swap in a fake that
// advances synchronously instead of sleeping on the real clock — real-timer
// waits on these hooks' 30ms/60ms backstops are exactly what made them flake
// under CI's sharded, CPU-contended `bun run test` (CL-7488).
export type Clock = {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
};

export const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
