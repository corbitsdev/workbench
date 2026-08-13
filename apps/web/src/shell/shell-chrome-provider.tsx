// Owns the shell chrome state that has to be visible above both the command
// palette and the shell frame: canvas state (open/profile/focus) and col2's
// collapse/width state. CommandPaletteProvider and AppShell are siblings in
// app.tsx's Shell — a palette action that "closes the canvas" or "toggles
// the sidebar" has to mutate the same state AppShell renders from, not a
// second copy scoped to AppShell's own subtree. This is the one place that
// state lives; AppShell consumes it through the same hooks page code
// already uses (`useCloseCanvas`, `useStageChrome`, ...) plus the couple of
// shell-only reads (`useCanvasColumnOpen`, `toggleMounted`) it needs for its
// own render.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useBench } from "../bench-context";
import { channelIdFromPath, channelPath, isChannelPath } from "../channel-path";
import { isMyraChannelId } from "../myra-channel";
import type { ProfileSubject } from "@corbits/chat-ui";
import { canvasColumnAllowed, contextualPanelIsDrawer } from "./breakpoints";
import { CanvasAvailabilityProvider } from "./canvas-availability";
import {
  clearCanvasForTenantSwitch,
  clearProfileInCanvas,
  initialCanvasColumnState,
  openProfileInCanvas,
  resolveCanvasFocus,
  resolveCanvasVisibility,
} from "./canvas-column-state";
import {
  deriveCol2Width,
  StageChromeProvider,
  useToggleRegistry,
  type StageChrome,
} from "./stage-chrome";
import { useShellLayoutMode } from "./use-shell-layout";

export function ShellChromeProvider({
  path,
  navigate,
  children,
}: {
  readonly path: string;
  readonly navigate: (to: string) => void;
  readonly children: ReactNode;
}) {
  const { selectedTenantId } = useBench();
  const layoutMode = useShellLayoutMode();
  const canvasAllowed = canvasColumnAllowed(layoutMode);
  const contextualAsDrawer = contextualPanelIsDrawer(layoutMode);

  const [canvasState, setCanvasState] = useState(initialCanvasColumnState);
  const [userCollapsedCol2, setUserCollapsedCol2] = useState(false);
  const [narrowPanelOpen, setNarrowPanelOpen] = useState(false);
  const { toggleMounted, registerToggle } = useToggleRegistry();

  // Tracks the last workbench we applied so a real switch (A→B) can drop
  // canvas state without treating the initial null→ready resolve as a switch.
  const previousTenantIdRef = useRef<string | null>(selectedTenantId);

  // Mock contract: every top-level navigation lands with col2 open again —
  // a collapse is a per-surface choice, not a sticky preference. Wide mode
  // needs no reset here: it is derived straight from `path` every render.
  useEffect(() => {
    setUserCollapsedCol2(false);
  }, [path]);

  // Workbench switch clears auxiliary canvas content and leaves any channel
  // deep link so the stage does not keep a foreign conversation under the
  // new workbench.
  useEffect(() => {
    const previousTenantId = previousTenantIdRef.current;
    if (
      previousTenantId !== null &&
      selectedTenantId !== null &&
      previousTenantId !== selectedTenantId
    ) {
      previousTenantIdRef.current = selectedTenantId;
      setCanvasState(clearCanvasForTenantSwitch());
      if (isChannelPath(path) && channelIdFromPath(path) !== null) {
        navigate(channelPath(null));
      }
      return;
    }
    previousTenantIdRef.current = selectedTenantId;
  }, [path, selectedTenantId, navigate]);

  const openProfile = useCallback((subject: ProfileSubject) => {
    setCanvasState((state) => openProfileInCanvas(state, subject));
  }, []);

  const closeProfile = useCallback(() => {
    setCanvasState((state) => clearProfileInCanvas(state));
  }, []);

  // Canvas-dominant focus collapses col2 outright — there is no room for a
  // third column while the canvas is reading full-screen. No trigger sets
  // `canvasState.focus` yet (that is a future canvas-focus control's job);
  // this just makes col2 obey the moment one exists.
  const canvasFocused = resolveCanvasFocus(canvasState, canvasAllowed);
  // Wide is route-derived: col2 widens for the Talk-to-Myra context, the
  // moment the open channel is the one "Talk to Myra" last landed us on.
  const col2Wide = isMyraChannelId(channelIdFromPath(path));
  const col2Width = contextualAsDrawer
    ? narrowPanelOpen
      ? "normal"
      : "collapsed"
    : deriveCol2Width({
        userCollapsed: userCollapsedCol2,
        canvasFocused,
        wideRoute: col2Wide,
      });
  const col2Collapsed = col2Width === "collapsed";

  // ONE collapse control (the stage top bar's toggle) drives both regimes:
  // in-flow col2 collapses on wide layouts; the overlay drawer opens on
  // narrow ones. There are no per-column chevrons.
  const toggleCol2 = useCallback(() => {
    if (contextualAsDrawer) {
      setNarrowPanelOpen((open) => !open);
      return;
    }
    setUserCollapsedCol2((collapsed) => !collapsed);
  }, [contextualAsDrawer]);

  const stageChrome = useMemo<StageChrome>(
    () => ({
      col2Collapsed,
      col2Width,
      toggleCol2,
      registerToggle,
      toggleMounted,
    }),
    [col2Collapsed, col2Width, toggleCol2, registerToggle, toggleMounted],
  );

  const canvasOpen = resolveCanvasVisibility(canvasState, canvasAllowed);

  return (
    <CanvasAvailabilityProvider
      allowed={canvasAllowed}
      open={canvasOpen}
      profile={canvasState.profile}
      openProfile={openProfile}
      closeProfile={closeProfile}
    >
      <StageChromeProvider value={stageChrome}>{children}</StageChromeProvider>
    </CanvasAvailabilityProvider>
  );
}
