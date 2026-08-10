// The four-column app shell: the global rail, the contextual panel, the
// main pane a route renders into, and the optional canvas. Every route in
// `../routes.tsx` mounts inside this same frame — there is no per-route
// shell variant. The canvas hosts the channel chat surface; its toggle
// lives in the panel page band, never as an absolute overlay over page
// actions. Deep links (`/c/:channelId`) open the canvas onto that channel.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { PanelLeft } from "lucide-react";

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
  initialCanvasColumnState,
  openChannelInCanvas,
  resolveCanvasVisibility,
  toggleCanvasColumn,
} from "./canvas-column-state";
import { CanvasAvailabilityProvider } from "./canvas-availability";
import { CanvasColumn } from "./canvas-column";
import { ContextualPanel } from "./contextual-panel";
import { Rail } from "./rail";
import { useShellLayoutMode } from "./use-shell-layout";

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
  const layoutMode = useShellLayoutMode();
  // Deep links seed canvas state on first paint (SSR and client) so a `/c/:id`
  // URL is not effect-only. Later path changes re-apply through the effect.
  const [canvasState, setCanvasState] = useState(() =>
    applyChannelPathToCanvas(initialCanvasColumnState(), path),
  );
  const canvasAllowed = canvasColumnAllowed(layoutMode);
  const canvasOpen = resolveCanvasVisibility(canvasState, canvasAllowed);
  const showContextualColumn = contextualPanelVisible(layoutMode);
  const contextualAsDrawer = contextualPanelIsDrawer(layoutMode);
  const [narrowPanelOpen, setNarrowPanelOpen] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  useShellFocusRescue(layoutMode, frameRef);
  // Route changes must not inherit the previous page's scroll position.
  useScrollReset(mainRef, path);

  // A deep link or in-app channel navigation feeds the canvas the same
  // channel id the URL carries. Closing the canvas does not clear the URL
  // here — the toggle only flips open/closed so reopening lands on the
  // same conversation.
  useEffect(() => {
    setCanvasState((state) => applyChannelPathToCanvas(state, path));
  }, [path]);

  const handleChannelChange = (channelId: string) => {
    setCanvasState(openChannelInCanvas(channelId));
    if (!isChannelPath(path) || channelIdFromPath(path) !== channelId) {
      navigate(channelPath(channelId));
    }
  };

  // Open a channel into the canvas without leaving the current page. Unlike
  // handleChannelChange, this never touches the URL — a channel row click in
  // col2 should pop the conversation open in col4 and keep the user on /library
  // (or wherever they are). Deep-link navigation is reserved for the URL.
  const handleOpenInCanvas = (channelId: string) => {
    setCanvasState(openChannelInCanvas(channelId));
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
            channelId={canvasState.channelId}
            onChannelChange={handleChannelChange}
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
