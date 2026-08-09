// The four-column app shell: the global rail, the contextual panel, the
// main pane a route renders into, and the optional canvas. Every route in
// `../routes.tsx` mounts inside this same frame — there is no per-route
// shell variant. The canvas hosts the channel chat surface; its toggle
// lives in the panel page band, never as an absolute overlay over page
// actions. Deep links (`/c/:channelId`) open the canvas onto that channel.

import { useEffect, useRef, useState, type ReactNode } from "react";

import { channelIdFromPath, channelPath, isChannelPath } from "../channel-path";
import { useNavigate } from "../navigation";
import type { SessionUser } from "../session";
import { canvasColumnAllowed, contextualPanelVisible } from "./breakpoints";
import { useShellFocusRescue } from "./focus-rescue";
import { useScrollReset } from "./use-scroll-reset";
import {
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
  const [canvasState, setCanvasState] = useState(initialCanvasColumnState);
  const canvasAllowed = canvasColumnAllowed(layoutMode);
  const canvasOpen = resolveCanvasVisibility(canvasState, canvasAllowed);
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
    const channelId = channelIdFromPath(path);
    if (channelId === null) return;
    setCanvasState((state) => openChannelInCanvas(state, channelId));
  }, [path]);

  const handleChannelChange = (channelId: string) => {
    setCanvasState((state) => openChannelInCanvas(state, channelId));
    if (!isChannelPath(path) || channelIdFromPath(path) !== channelId) {
      navigate(channelPath(channelId));
    }
  };

  return (
    <CanvasAvailabilityProvider allowed={canvasAllowed}>
      <div className="shell-frame" ref={frameRef}>
        <Rail
          path={path}
          onNavigate={navigate}
          user={user}
          onSignOut={onSignOut}
        />
        {contextualPanelVisible(layoutMode) && (
          <ContextualPanel
            path={path}
            onNavigate={navigate}
            canvasOpen={canvasState.open}
            onToggleCanvas={() => setCanvasState(toggleCanvasColumn)}
            canvasAllowed={canvasAllowed}
          />
        )}
        <div className="shell-main" ref={mainRef}>
          <div className="shell-main-content">{children}</div>
        </div>
        {canvasAllowed && (
          <CanvasColumn
            open={canvasOpen}
            channelId={canvasState.channelId}
            onChannelChange={handleChannelChange}
          />
        )}
      </div>
    </CanvasAvailabilityProvider>
  );
}
