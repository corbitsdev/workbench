import { useEffect, type EffectCallback } from "react";

/**
 * Run an effect exactly once, on mount. A thin wrapper over `useEffect(fn, [])`
 * that names the intent and keeps the empty-deps lint suppression in one place.
 */
export function useMountEffect(effect: EffectCallback): void {
  useEffect(effect, []);
}
