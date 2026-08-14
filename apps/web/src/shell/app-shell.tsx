// The four-column app shell: the global rail, the contextual panel, the
// main pane a route renders into, and the optional canvas. Every route in
// `../routes.tsx` mounts inside this same frame — there is no per-route
// shell variant. Channel conversation lives in the main stage; the canvas
// is auxiliary (profiles and similar) and opens on use, then closes
// internally. There is no permanent canvas toggle.
//
// Canvas state and col2's collapse/width state are NOT owned here — they
// have to be visible to the command palette too (a sibling of this
// component, not a descendant — see `shell-chrome-provider.tsx`), so
// `ShellChromeProvider` owns them above both and this component only reads
// them through the same hooks page code already uses.

import { useRef, type ReactNode } from "react";

import { useNavigate } from "../navigation";
import type { SessionUser } from "../session";
import {
  contextualPanelIsDrawer,
  contextualPanelVisible,
  railShowLabels,
} from "./breakpoints";
import { useShellFocusRescue } from "./focus-rescue";
import { useScrollReset } from "./use-scroll-reset";
import {
  useCanvasColumnArtifact,
  useCanvasColumnAvailable,
  useCanvasColumnFocus,
  useCanvasColumnOpen,
  useCanvasColumnProfile,
  useCloseCanvas,
  useToggleCanvasFocus,
} from "./canvas-availability";
import { CanvasColumn } from "./canvas-column";
import { ShellContextMenu } from "./context-menu/shell-context-menu";
import { ContextualPanel } from "./contextual-panel";
import { Rail } from "./rail";
import { COL2_ID, Col2EdgeHandle, useStageChrome } from "./stage-chrome";
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
  const canvasAllowed = useCanvasColumnAvailable();
  const canvasOpen = useCanvasColumnOpen();
  const canvasProfile = useCanvasColumnProfile();
  const canvasArtifact = useCanvasColumnArtifact();
  const canvasFocus = useCanvasColumnFocus();
  const closeCanvas = useCloseCanvas();
  const toggleCanvasFocus = useToggleCanvasFocus();
  const showContextualColumn = contextualPanelVisible(layoutMode);
  const contextualAsDrawer = contextualPanelIsDrawer(layoutMode);
  const { col2Collapsed, col2Width, toggleCol2 } = useStageChrome();
  const frameRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  useShellFocusRescue(layoutMode, frameRef);
  // Route changes must not inherit the previous page's scroll position.
  useScrollReset(mainRef, path);

  return (
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
        showLabels={railShowLabels(layoutMode)}
      />
      {showContextualColumn && !col2Collapsed && (
        <ContextualPanel id={COL2_ID} path={path} onNavigate={navigate} />
      )}
      {col2Collapsed && <Col2EdgeHandle />}
      <div className="shell-main" ref={mainRef}>
        <div className="shell-main-content">{children}</div>
      </div>
      {canvasAllowed && (
        <CanvasColumn
          open={canvasOpen}
          profile={canvasProfile}
          artifact={canvasArtifact}
          focus={canvasFocus}
          onClose={closeCanvas}
          onToggleFocus={toggleCanvasFocus}
          onNavigate={navigate}
        />
      )}
      {contextualAsDrawer && (
        <>
          <div
            className="shell-drawer-backdrop"
            data-open={!col2Collapsed}
            onClick={toggleCol2}
          />
          <div
            id={COL2_ID}
            className="shell-drawer"
            data-open={!col2Collapsed}
            inert={col2Collapsed}
          >
            <ContextualPanel path={path} onNavigate={navigate} />
          </div>
        </>
      )}
      <ShellContextMenu onSignOut={onSignOut} />
    </div>
  );
}
