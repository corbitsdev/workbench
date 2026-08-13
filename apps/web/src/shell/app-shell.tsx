// The four-column app shell: the global rail, the contextual panel, the
// main pane a route renders into, and the optional canvas. Every route in
// `../routes.tsx` mounts inside this same frame — there is no per-route
// shell variant. Channel conversation lives in the main stage; the canvas
// is auxiliary (profiles and similar) and opens on use, then closes
// internally. There is no permanent canvas toggle.
//
// Workbench (tenant) selection is the outer scope for channels. Switching
// workbenches clears canvas auxiliary content and leaves channel deep links
// so a foreign conversation cannot stay loaded under the new workbench.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useBench } from "../bench-context";
import { channelIdFromPath, channelPath, isChannelPath } from "../channel-path";
import { isMyraChannelId } from "../myra-channel";
import { useNavigate } from "../navigation";
import type { SessionUser } from "../session";
import {
  canvasColumnAllowed,
  contextualPanelIsDrawer,
  contextualPanelVisible,
  railShowLabels,
} from "./breakpoints";
import { useShellFocusRescue } from "./focus-rescue";
import { useScrollReset } from "./use-scroll-reset";
import {
  clearCanvasForTenantSwitch,
  clearProfileInCanvas,
  initialCanvasColumnState,
  openProfileInCanvas,
  resolveCanvasFocus,
  resolveCanvasVisibility,
} from "./canvas-column-state";
import { CanvasAvailabilityProvider } from "./canvas-availability";
import { CanvasColumn } from "./canvas-column";
import { ShellContextMenu } from "./context-menu/shell-context-menu";
import { ContextualPanel } from "./contextual-panel";
import { Rail } from "./rail";
import {
  COL2_ID,
  deriveCol2Width,
  StageChromeProvider,
  StageToggleFallback,
  useToggleRegistry,
  type StageChrome,
} from "./stage-chrome";
import { useShellLayoutMode } from "./use-shell-layout";
import type { ProfileSubject } from "@corbits/chat-ui";

export function AppShell({
  path,
  user,
  onSignOut,
  children,
}: {
  readonly path: string;
  readonly user: SessionUser;
  readonly onSignOut: () => void;
  readonly children: ReactNode;
}) {
  const navigate = useNavigate();
  const { selectedTenantId } = useBench();
  const layoutMode = useShellLayoutMode();
  const [canvasState, setCanvasState] = useState(initialCanvasColumnState);
  const canvasAllowed = canvasColumnAllowed(layoutMode);
  const canvasOpen = resolveCanvasVisibility(canvasState, canvasAllowed);
  const showContextualColumn = contextualPanelVisible(layoutMode);
  const contextualAsDrawer = contextualPanelIsDrawer(layoutMode);
  const [narrowPanelOpen, setNarrowPanelOpen] = useState(false);
  const [userCollapsedCol2, setUserCollapsedCol2] = useState(false);
  const { toggleMounted, registerToggle } = useToggleRegistry();
  const frameRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  // Tracks the last workbench we applied so a real switch (A→B) can drop
  // canvas state without treating the initial null→ready resolve as a switch.
  const previousTenantIdRef = useRef<string | null>(selectedTenantId);
  useShellFocusRescue(layoutMode, frameRef);
  // Route changes must not inherit the previous page's scroll position.
  useScrollReset(mainRef, path);

  // Mock contract: every top-level navigation lands with col2 open again —
  // a collapse is a per-surface choice, not a sticky preference. Wide mode
  // needs no reset here: it is derived straight from `path` every render
  // (see `col2Width` below), so it already turns off the moment the route
  // stops being the Myra channel.
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

  const handleOpenProfile = (subject: ProfileSubject) => {
    setCanvasState((state) => openProfileInCanvas(state, subject));
  };

  const handleCloseProfile = () => {
    setCanvasState((state) => clearProfileInCanvas(state));
  };

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
  const stageChrome = useMemo<StageChrome>(
    () => ({
      col2Collapsed,
      toggleCol2: () => {
        if (contextualAsDrawer) {
          setNarrowPanelOpen((open) => !open);
          return;
        }
        setUserCollapsedCol2((collapsed) => !collapsed);
      },
      registerToggle,
    }),
    [contextualAsDrawer, col2Collapsed, registerToggle],
  );

  return (
    <CanvasAvailabilityProvider
      allowed={canvasAllowed}
      openProfile={handleOpenProfile}
      closeProfile={handleCloseProfile}
    >
      <div
        className="shell-frame"
        ref={frameRef}
        data-layout={layoutMode}
        data-col2={col2Width}
      >
        <Rail
          path={path}
          onNavigate={navigate}
          user={user}
          onSignOut={onSignOut}
          showLabels={railShowLabels(layoutMode)}
        />
        {showContextualColumn && !col2Collapsed && (
          <ContextualPanel id={COL2_ID} path={path} onNavigate={navigate} />
        )}
        <div className="shell-main" ref={mainRef}>
          <StageChromeProvider value={stageChrome}>
            {!toggleMounted && <StageToggleFallback />}
            <div className="shell-main-content">{children}</div>
          </StageChromeProvider>
        </div>
        {canvasAllowed && (
          <CanvasColumn
            open={canvasOpen}
            profile={canvasState.profile}
            onCloseProfile={handleCloseProfile}
            onNavigate={navigate}
          />
        )}
        {contextualAsDrawer && (
          <>
            <div
              className="shell-drawer-backdrop"
              data-open={narrowPanelOpen}
              onClick={() => setNarrowPanelOpen(false)}
            />
            <div
              id={COL2_ID}
              className="shell-drawer"
              data-open={narrowPanelOpen}
              inert={!narrowPanelOpen}
            >
              <ContextualPanel path={path} onNavigate={navigate} />
            </div>
          </>
        )}
        <ShellContextMenu />
      </div>
    </CanvasAvailabilityProvider>
  );
}
