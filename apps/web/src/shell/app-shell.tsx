// The four-column app shell: the global rail, the contextual panel, the
// main pane a route renders into, and the optional canvas. Every route in
// `../routes.tsx` mounts inside this same frame — there is no per-route
// shell variant. The canvas hosts the channel chat surface; its toggle
// lives in the panel page band, never as an absolute overlay over page
// actions. Deep links (`/c/:channelId`) open the canvas onto that channel
// under the currently selected workbench.
//
// Workbench (tenant) selection is the outer scope for channels. Switching
// workbenches clears any open canvas channel and leaves channel deep links
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
  applyChannelPathToCanvas,
  channelIdForTenant,
  clearCanvasForTenantSwitch,
  clearProfileInCanvas,
  initialCanvasColumnState,
  openChannelInCanvas,
  openProfileInCanvas,
  resolveCanvasVisibility,
  toggleCanvasColumn,
} from "./canvas-column-state";
import { CanvasAvailabilityProvider } from "./canvas-availability";
import { CanvasColumn } from "./canvas-column";
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
  // Deep links seed canvas state on first paint only when a workbench is
  // already selected; otherwise the path effect waits for tenant resolution.
  const [canvasState, setCanvasState] = useState(() =>
    applyChannelPathToCanvas(
      initialCanvasColumnState(),
      path,
      selectedTenantId,
    ),
  );
  const canvasAllowed = canvasColumnAllowed(layoutMode);
  const canvasOpen = resolveCanvasVisibility(canvasState, canvasAllowed);
  const canvasChannelId = channelIdForTenant(canvasState, selectedTenantId);
  const showContextualColumn = contextualPanelVisible(layoutMode);
  const contextualAsDrawer = contextualPanelIsDrawer(layoutMode);
  const [narrowPanelOpen, setNarrowPanelOpen] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  // Tracks the last workbench we applied so a real switch (A→B) can drop
  // channel state without treating the initial null→ready resolve as a switch.
  const previousTenantIdRef = useRef<string | null>(selectedTenantId);
  useShellFocusRescue(layoutMode, frameRef);
  // Route changes must not inherit the previous page's scroll position.
  useScrollReset(mainRef, path);

  // Workbench switch and channel deep links share one effect so a switch
  // never races a path re-apply that would reopen the foreign channel.
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
    setCanvasState((state) =>
      applyChannelPathToCanvas(state, path, selectedTenantId),
    );
  }, [path, selectedTenantId, navigate]);

  const handleChannelChange = (channelId: string) => {
    if (selectedTenantId === null) return;
    setCanvasState(openChannelInCanvas(channelId, selectedTenantId));
    if (!isChannelPath(path) || channelIdFromPath(path) !== channelId) {
      navigate(channelPath(channelId));
    }
  };

  // Open a channel into the canvas without leaving the current page. Unlike
  // handleChannelChange, this never touches the URL — a channel row click in
  // col2 should pop the conversation open in col4 and keep the user on /library
  // (or wherever they are). Deep-link navigation is reserved for the URL.
  const handleOpenInCanvas = (channelId: string) => {
    if (selectedTenantId === null) return;
    setCanvasState(openChannelInCanvas(channelId, selectedTenantId));
  };

  const handleOpenProfile = (subject: ProfileSubject) => {
    setCanvasState((state) => openProfileInCanvas(state, subject));
  };

  const handleCloseProfile = () => {
    setCanvasState((state) => clearProfileInCanvas(state));
  };

  return (
    <CanvasAvailabilityProvider allowed={canvasAllowed}>
      <div className="shell-frame" ref={frameRef} data-layout={layoutMode}>
        <Rail
          path={path}
          onNavigate={navigate}
          user={user}
          onSignOut={onSignOut}
          showLabels={railShowLabels(layoutMode)}
        />
        {showContextualColumn && (
          <ContextualPanel
            path={path}
            onNavigate={navigate}
            canvasOpen={canvasState.open}
            onToggleCanvas={() => setCanvasState(toggleCanvasColumn)}
            canvasAllowed={canvasAllowed}
            onOpenInCanvas={handleOpenInCanvas}
          />
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
            channelId={canvasChannelId}
            profile={canvasState.profile}
            onChannelChange={handleChannelChange}
            onOpenProfile={handleOpenProfile}
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
              <ContextualPanel
                path={path}
                onNavigate={navigate}
                canvasOpen={canvasState.open}
                onToggleCanvas={() => setCanvasState(toggleCanvasColumn)}
                canvasAllowed={canvasAllowed}
                onOpenInCanvas={handleOpenInCanvas}
              />
            </div>
          </>
        )}
      </div>
    </CanvasAvailabilityProvider>
  );
}
