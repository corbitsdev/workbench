import { useEffect, useState } from "react";

/**
 * Deliberately coarser than trace-waterfall's formatStepDuration: this backs
 * a live ticker that recomputes once per second (see useElapsedTime below),
 * so sub-second precision (an `ms` branch, decimal seconds under 10s) would
 * only flicker between rounding artifacts, not convey real precision.
 * formatStepDuration formats an exact, already-closed span between two fixed
 * timestamps, where that precision is real and worth showing.
 */
export function formatElapsedMs(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

/**
 * Ticking "time since `startedAt`" for an in-flight step, recomputed once per
 * second so the running indicator advances without a new API call. Returns
 * null once `active` is false (the step is no longer in flight).
 */
export function useElapsedTime(
  startedAt: string | undefined,
  active: boolean,
): string | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active || startedAt === undefined) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, startedAt]);

  if (!active || startedAt === undefined) return null;
  const startMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startMs)) return null;
  return formatElapsedMs(now - startMs);
}
