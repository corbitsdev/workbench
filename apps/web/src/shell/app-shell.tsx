// The four-column app shell: the global rail, the contextual panel, the
// main pane a route renders into, and the optional canvas. Every route in
// `../routes.tsx` mounts inside this same frame — there is no per-route
// shell variant.

import { useRef, useState, type ReactNode } from "react";

import { useNavigate } from "../navigation";
import type { SessionUser } from "../session";
import { canvasColumnAllowed, contextualPanelVisible } from "./breakpoints";
import { useShellFocusRescue } from "./focus-rescue";
import {
  initialCanvasColumnState,
  resolveCanvasVisibility,
  toggleCanvasColumn,
} from "./canvas-column-state";
import { CanvasColumn, CanvasToggle } from "./canvas-column";
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
  useShellFocusRescue(layoutMode, frameRef);

  return (
    <div className="shell-frame" ref={frameRef}>
      <Rail
        path={path}
        onNavigate={navigate}
        user={user}
        onSignOut={onSignOut}
      />
      {contextualPanelVisible(layoutMode) && (
        <ContextualPanel path={path} onNavigate={navigate} />
      )}
      <div className="shell-main">
        {canvasAllowed && (
          <div className="shell-main-toolbar">
            <CanvasToggle
              open={canvasState.open}
              onToggle={() => setCanvasState(toggleCanvasColumn)}
            />
          </div>
        )}
        <div className="shell-main-content">{children}</div>
      </div>
      {canvasAllowed && <CanvasColumn open={canvasOpen} />}
    </div>
  );
}
