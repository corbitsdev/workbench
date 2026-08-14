// The shell side of col2's collapse contract: the state a toggle flips, and
// the expand affordance the shell renders at col2's boundary whenever it is
// collapsed. The control itself lives on col2 (its own header) while col2 is
// open — this module only owns what has to live above col2's own render:
// the shared state and the affordance for when col2 isn't there to carry it.

import { ChevronRight } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";

/** The id of whichever col2 container is in the tree (in-flow panel or
 * narrow drawer — never both), targeted by every toggle's aria-controls. */
export const COL2_ID = "shell-col2";

/** The mock's `data-col2` values: `collapsed` (user toggle or canvas focus),
 * `wide` (the Talk-to-Myra context wants more room), `normal` otherwise. */
export type Col2Width = "collapsed" | "normal" | "wide";

/**
 * Pure precedence rule behind `data-col2`, mirroring the mock's
 * `applyLayout`: canvas focus wins outright (there is no col2 to show while
 * the canvas is dominant), then the user's own collapse choice, then the
 * route-derived wide context, then normal.
 */
export function deriveCol2Width(input: {
  readonly userCollapsed: boolean;
  readonly canvasFocused: boolean;
  readonly wideRoute: boolean;
}): Col2Width {
  if (input.canvasFocused || input.userCollapsed) return "collapsed";
  if (input.wideRoute) return "wide";
  return "normal";
}

export type StageChrome = {
  readonly col2Collapsed: boolean;
  /** The full three-state width `col2Collapsed` collapses down from —
   * AppShell reads this directly for `data-col2`; `col2Collapsed` remains
   * the boolean pages actually branch on. */
  readonly col2Width: Col2Width;
  readonly toggleCol2: () => void;
};

const StageChromeContext = createContext<StageChrome>({
  col2Collapsed: false,
  col2Width: "normal",
  toggleCol2: () => undefined,
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

/** Col2's own expand affordance once it has collapsed out of the flow: a
 * slim full-height strip at the boundary where col2 used to sit. The shell
 * renders this whenever col2 is collapsed — in-flow or behind a closed
 * narrow drawer — so reachability is a property of col2's state, never of
 * whether the current page happens to render its own chrome. */
export function Col2EdgeHandle() {
  const { col2Collapsed, toggleCol2 } = useStageChrome();
  return (
    <button
      type="button"
      className="shell-col2-edge-handle"
      aria-label="Expand sidebar"
      title="Expand sidebar"
      aria-expanded={!col2Collapsed}
      aria-controls={COL2_ID}
      onClick={toggleCol2}
    >
      <ChevronRight aria-hidden="true" />
    </button>
  );
}
