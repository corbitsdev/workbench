// The shell side of the stage top-bar contract: the col2 collapse state a
// toggle flips, the registry that tracks whether any toggle is mounted, and
// the fallback control the shell shows when a stage state renders without
// one — so the single col2 control is always reachable, enforced here and
// never by page discipline.

import { PanelLeft } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

/** The id of whichever col2 container is in the tree (in-flow panel or
 * narrow drawer — never both), targeted by every toggle's aria-controls. */
export const COL2_ID = "shell-col2";

export type StageChrome = {
  readonly col2Collapsed: boolean;
  readonly toggleCol2: () => void;
  /** Every mounted toggle registers itself and returns its unregister; the
   * shell shows its own fallback control while none is registered. */
  readonly registerToggle: () => () => void;
};

const StageChromeContext = createContext<StageChrome>({
  col2Collapsed: false,
  toggleCol2: () => undefined,
  registerToggle: () => () => undefined,
});

export function StageChromeProvider({
  value,
  children,
}: {
  readonly value: StageChrome;
  readonly children: ReactNode;
}) {
  return (
    <StageChromeContext.Provider value={value}>
      {children}
    </StageChromeContext.Provider>
  );
}

export function useStageChrome(): StageChrome {
  return useContext(StageChromeContext);
}

/** Stage chrome for a mounted toggle: registers it for the lifetime of the
 * calling component so the shell can drop its fallback control. */
export function useRegisteredToggle(): StageChrome {
  const chrome = useStageChrome();
  const { registerToggle } = chrome;
  useEffect(() => registerToggle(), [registerToggle]);
  return chrome;
}

/** The shell's side of the registry: whether any toggle is mounted, and the
 * stable register function it hands out through StageChromeProvider. */
export function useToggleRegistry(): {
  readonly toggleMounted: boolean;
  readonly registerToggle: () => () => void;
} {
  const [mountedCount, setMountedCount] = useState(0);
  const registerToggle = useCallback(() => {
    setMountedCount((count) => count + 1);
    return () => setMountedCount((count) => count - 1);
  }, []);
  return { toggleMounted: mountedCount > 0, registerToggle };
}

/** Floating minimal toggle for stage states that render no top bar (boot
 * screens, signed-out notices, load failures). Same accessible name as the
 * top-bar toggle — it is the same control, shell-owned. */
export function StageToggleFallback() {
  const { col2Collapsed, toggleCol2 } = useStageChrome();
  return (
    <button
      type="button"
      className="stage-toggle-fallback"
      aria-label="Toggle sidebar"
      title="Toggle sidebar"
      aria-expanded={!col2Collapsed}
      aria-controls={COL2_ID}
      onClick={toggleCol2}
    >
      <PanelLeft />
    </button>
  );
}
