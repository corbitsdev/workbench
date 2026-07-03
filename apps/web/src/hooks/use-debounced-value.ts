import { useEffect, useState } from "react";

/**
 * Returns `value` after it has been stable for `delayMs`. Used to gate
 * server-backed search queries so a keystroke burst issues one request.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
