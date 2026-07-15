import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * Returns a re-render trigger safe to call at stream frequency (e.g. once per
 * SSE token). Bursts of calls coalesce into a single update per animation
 * frame, and the update is issued inside `React.startTransition`.
 *
 * The transition wrapper is load-bearing, not an optimization: react-router
 * applies navigations inside a transition, and transition lanes never expire.
 * A per-token synchronous setState is an urgent update that interrupts and
 * restarts the pending navigation render each time it fires — while an agent
 * streams, the URL changes on click but the route never commits.
 * Marking stream repaints as transitions lets them batch with the navigation
 * instead of starving it.
 */
export function useStreamRerender(): () => void {
  const [, setTick] = useState(0);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, []);

  return useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      startTransition(() => setTick((n) => n + 1));
    });
  }, []);
}
