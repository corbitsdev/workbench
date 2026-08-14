// Owns the shell chrome state that has to be visible above both the command
// palette and the shell frame: canvas state (open/profile/focus) and col2's
// collapse/width state. CommandPaletteProvider and AppShell are siblings in
// app.tsx's Shell — a palette action that "closes the canvas" or "toggles
// the sidebar" has to mutate the same state AppShell renders from, not a
// second copy scoped to AppShell's own subtree. This is the one place that
// state lives; AppShell consumes it through the same hooks page code
// already uses (`useCloseCanvas`, `useStageChrome`, ...) plus the shell-only
// read (`useCanvasColumnOpen`) it needs for its own render.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { getPreferences, patchPreferences } from "@corbits/preferences/client";

import { useBench } from "../bench-context";
import { channelIdFromPath, channelPath, isChannelPath } from "../channel-path";
import { isMyraChannelId } from "../myra-channel";
import type { ProfileSubject } from "@corbits/chat-ui";
import { canvasColumnAllowed, contextualPanelIsDrawer } from "./breakpoints";
import { CanvasAvailabilityProvider } from "./canvas-availability";
import {
  col2CollapsedFromPreferences,
  COL2_COLLAPSED_PREFERENCE_KEY,
} from "./col2-preference";
import {
  clearCanvasForTenantSwitch,
  closeCanvasContent,
  initialCanvasColumnState,
  openArtifactInCanvas,
  openProfileInCanvas,
  resolveCanvasFocus,
  resolveCanvasVisibility,
  toggleCanvasFocus,
  type CanvasArtifactContent,
} from "./canvas-column-state";
import {
  deriveCol2Width,
  StageChromeProvider,
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

  // Tracks the last workbench we applied so a real switch (A→B) can drop
  // canvas state without treating the initial null→ready resolve as a switch.
  const previousTenantIdRef = useRef<string | null>(selectedTenantId);

  // Mock contract: every top-level navigation lands with col2 open again —
  // a collapse is a per-surface choice, not a sticky preference. Wide mode
  // needs no reset here: it is derived straight from `path` every render.
  useEffect(() => {
    setUserCollapsedCol2(false);
  }, [path]);

  // Hydrate the *general* collapse preference once, on the first tenant
  // resolve — distinct from the per-navigation reset above, which is about
  // in-session surface switches, not surviving a reload. Runs once (not on
  // every tenant switch) so a later bench switch does not reopen col2 out
  // from under a mid-session collapse.
  const hydratedFromPreferenceRef = useRef(false);
  useEffect(() => {
    if (hydratedFromPreferenceRef.current || selectedTenantId === null) return;
    hydratedFromPreferenceRef.current = true;
    let cancelled = false;
    void getPreferences(selectedTenantId)
      .then((preferences) => {
        if (cancelled) return;
        if (col2CollapsedFromPreferences(preferences)) {
          setUserCollapsedCol2(true);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedTenantId]);

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

  const openArtifact = useCallback((artifact: CanvasArtifactContent) => {
    setCanvasState((state) => openArtifactInCanvas(state, artifact));
  }, []);

  const closeCanvas = useCallback(() => {
    setCanvasState((state) => closeCanvasContent(state));
  }, []);

  const toggleFocus = useCallback(() => {
    setCanvasState((state) => toggleCanvasFocus(state));
  }, []);

  // Canvas-dominant focus collapses col2 outright — there is no room for a
  // third column while the canvas is reading full-screen. `toggleFocus`
  // (the mock's `data-action="canvas-focus"` control, rendered in the
  // canvas pane header) is what sets `canvasState.focus` now.
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

  // ONE collapse control drives both regimes — col2's own header toggle
  // while it's open, the shell's edge handle once it's collapsed: in-flow
  // col2 collapses on wide layouts; the overlay drawer opens on narrow
  // ones. There are no per-column chevrons.
  // The user's own collapse choice PATCHes the preferences store too, fire-
  // and-forget — the shell's own toggle state (`setUserCollapsedCol2`)
  // already updated the UI synchronously; a failed PATCH just means the
  // next reload doesn't remember it, not a broken toggle.
  const toggleCol2 = useCallback(() => {
    if (contextualAsDrawer) {
      setNarrowPanelOpen((open) => !open);
      return;
    }
    const next = !userCollapsedCol2;
    setUserCollapsedCol2(next);
    if (selectedTenantId !== null) {
      void patchPreferences(selectedTenantId, {
        [COL2_COLLAPSED_PREFERENCE_KEY]: next,
      }).catch(() => undefined);
    }
  }, [contextualAsDrawer, userCollapsedCol2, selectedTenantId]);

  const stageChrome = useMemo<StageChrome>(
    () => ({
      col2Collapsed,
      col2Width,
      toggleCol2,
    }),
    [col2Collapsed, col2Width, toggleCol2],
  );

  const canvasOpen = resolveCanvasVisibility(canvasState, canvasAllowed);

  return (
    <CanvasAvailabilityProvider
      allowed={canvasAllowed}
      open={canvasOpen}
      profile={canvasState.profile}
      artifact={canvasState.artifact}
      focus={canvasFocused}
      openProfile={openProfile}
      openArtifact={openArtifact}
      toggleFocus={toggleFocus}
      close={closeCanvas}
    >
      <StageChromeProvider value={stageChrome}>{children}</StageChromeProvider>
    </CanvasAvailabilityProvider>
  );
}
