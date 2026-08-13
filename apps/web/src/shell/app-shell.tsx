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

import { useEffect, useRef, useState, type ReactNode } from "react";
import { PanelLeft } from "lucide-react";

import { useBench } from "../bench-context";
import { channelIdFromPath, channelPath, isChannelPath } from "../channel-path";
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
  resolveCanvasVisibility,
} from "./canvas-column-state";
import { CanvasAvailabilityProvider } from "./canvas-availability";
import { CanvasColumn } from "./canvas-column";
import { ShellContextMenu } from "./context-menu/shell-context-menu";
import { ContextualPanel } from "./contextual-panel";
import { Rail } from "./rail";
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
  const frameRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  // Tracks the last workbench we applied so a real switch (A→B) can drop
  // canvas state without treating the initial null→ready resolve as a switch.
  const previousTenantIdRef = useRef<string | null>(selectedTenantId);
  useShellFocusRescue(layoutMode, frameRef);
  // Route changes must not inherit the previous page's scroll position.
  useScrollReset(mainRef, path);

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

  return (
    <CanvasAvailabilityProvider
      allowed={canvasAllowed}
      openProfile={handleOpenProfile}
    >
      <div className="shell-frame" ref={frameRef} data-layout={layoutMode}>
        <Rail
          path={path}
          onNavigate={navigate}
          user={user}
          onSignOut={onSignOut}
          showLabels={railShowLabels(layoutMode)}
        />
        {showContextualColumn && (
          <ContextualPanel path={path} onNavigate={navigate} />
        )}
        <div className="shell-main" ref={mainRef}>
          {contextualAsDrawer && (
            <button
              type="button"
              className="shell-drawer-trigger"
              aria-label="Open panel"
              aria-expanded={narrowPanelOpen}
              onClick={() => setNarrowPanelOpen(true)}
            >
              <PanelLeft />
            </button>
          )}
          <div className="shell-main-content">{children}</div>
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
