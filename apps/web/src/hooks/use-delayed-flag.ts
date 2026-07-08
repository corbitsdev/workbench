import { useEffect, useState } from "react";

/**
 * Returns `true` only after `active` has stayed `true` continuously for
 * `delayMs`; drops back to `false` the instant `active` goes false. Used to
 * debounce the reconnecting overlay so brief drops never flash it, while a real
 * outage reveals it after the delay.
 */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!active) {
      setOn(false);
      return;
    }
    const id = setTimeout(() => setOn(true), delayMs);
    return () => clearTimeout(id);
  }, [active, delayMs]);

  return on;
}
