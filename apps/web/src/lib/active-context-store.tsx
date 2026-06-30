import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ActiveContext } from "@workbench/shared";

// The active-surface store (CL-2495). Each entity page publishes the surface the
// user is currently looking at; the docked Myra surface reads it so a keybind can
// attach it to the next message. Apps stay thin: the projection logic itself
// lives in `@workbench/shared` — this only holds the current ref.

interface ActiveContextStore {
  context: ActiveContext | null;
  setContext: (ctx: ActiveContext | null) => void;
}

const Ctx = createContext<ActiveContextStore | null>(null);

export function ActiveContextProvider({ children }: { children: ReactNode }) {
  const [context, setContext] = useState<ActiveContext | null>(null);
  const value = useMemo(() => ({ context, setContext }), [context]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Read the surface the user is currently looking at (or null). Tolerant of a
 * missing provider — the docked Myra surface is also rendered in tests and
 * standalone contexts where no surface is published — so it degrades to null
 * rather than throwing.
 */
export function useActiveContext(): ActiveContext | null {
  return useContext(Ctx)?.context ?? null;
}

/**
 * Publish the page's active surface into the store. Re-publishes only when the
 * stable `key` changes (kind+id plus any caller-supplied freshness token), so a
 * page that re-renders on every poll/stream tick does not thrash the store. The
 * latest `ctx` is always captured via a ref, so the published value is current
 * even though the effect is key-gated. Clears the store on unmount.
 *
 * No-ops when no provider is mounted (entity pages are unit-tested in isolation,
 * outside the AppShell that mounts the store).
 */
export function usePublishActiveContext(
  ctx: ActiveContext | null,
  freshnessToken?: string,
): void {
  const setContext = useContext(Ctx)?.setContext;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const key =
    ctx === null ? null : `${ctx.kind}:${ctx.id}:${freshnessToken ?? ""}`;

  const publish = useCallback(() => setContext?.(ctxRef.current), [setContext]);

  useEffect(() => {
    publish();
    return () => setContext?.(null);
  }, [key, publish, setContext]);
}
