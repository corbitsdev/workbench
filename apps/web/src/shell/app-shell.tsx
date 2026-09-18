// The app frame: one sidebar (the workbench list and shared chrome — see
// `sidebar.tsx`), the main pane a route renders into, and the optional
// canvas. Every route in `../routes.tsx` mounts inside this same frame —
// there is no per-route shell variant and no sidebar collapse. The
// conversation lives in the main stage; the canvas is auxiliary (profiles
// and similar) and opens on use, then closes internally.
//
// Canvas state is NOT owned here — it has to be visible to the command
// palette too (a sibling of this component, not a descendant — see
// `shell-chrome-provider.tsx`), so `ShellChromeProvider` owns it above both
// and this component only reads it through the same hooks page code
// already uses.

import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import type { ArtifactSaveState } from "@/library";

import { WorkbenchLoadingState } from "@/chat";

import { usePendingApprovalCount } from "../pending-approvals";
import { useBench } from "../bench-context";
import { useNavigate } from "../navigation";
import { saveArtifactContent } from "./library-artifacts";
import { APP_ROUTES, matchesRoute } from "../routes";
import type { SessionUser } from "../session";
import { StageTopBar } from "./stage-top-bar";
import { useScrollReset } from "@/shell/layout";
import {
  useCanvasColumnArtifact,
  useCanvasColumnAvailable,
  useCanvasColumnFocus,
  useCanvasColumnOpen,
  useCanvasColumnProfile,
  useCanvasColumnRoutine,
  useCloseCanvas,
  useToggleCanvasFocus,
} from "./canvas-availability";
import { Sidebar } from "./sidebar";
import { ShellContextMenu } from "./context-menu/shell-context-menu";

const CanvasColumn = lazy(async () => ({
  default: (await import("./canvas-column")).CanvasColumn,
}));

/** True only for the one route that never renders its own `StageTopBar`
 * (see `AppRoute.hasStageTopBar`'s doc) — everything else titles its own
 * stage, so this stays false for the rest. */
function routeHasNoStageTopBar(path: string): boolean {
  const route = APP_ROUTES.find((candidate) => matchesRoute(candidate.path, path));
  return route?.hasStageTopBar === false;
}

function routeLabel(path: string): string {
  const route = APP_ROUTES.find((candidate) => matchesRoute(candidate.path, path));
  return route?.label ?? "Workbench";
}

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
  const canvasAllowed = useCanvasColumnAvailable();
  const canvasOpen = useCanvasColumnOpen();
  const canvasProfile = useCanvasColumnProfile();
  const canvasArtifact = useCanvasColumnArtifact();
  const canvasRoutine = useCanvasColumnRoutine();
  const canvasFocus = useCanvasColumnFocus();
  const { selectedTenantId: tenantId } = useBench();

  // A text-kind artifact's save state (: single-user editing, no
  // co-edit presence). Resets to a fresh state the moment the open
  // artifact changes so a stale "Saved · v3" from a previous artifact can
  // never leak into a newly opened one.
  const [artifactSaveState, setArtifactSaveState] = useState<ArtifactSaveState>({
    kind: "read-only",
  });
  const artifactSaveStateForId = useRef<string | null>(null);
  useEffect(() => {
    if (canvasArtifact === null || canvasArtifact.rendererKind !== "doc") {
      artifactSaveStateForId.current = null;
      setArtifactSaveState({ kind: "read-only" });
      return;
    }
    if (artifactSaveStateForId.current === canvasArtifact.id) return;
    artifactSaveStateForId.current = canvasArtifact.id;
    setArtifactSaveState(
      canvasArtifact.canEdit === true ? { kind: "unsaved" } : { kind: "read-only" },
    );
  }, [canvasArtifact]);

  const saveArtifact = (content: string) => {
    if (tenantId === null || canvasArtifact === null) return;
    const artifactId = canvasArtifact.id;
    setArtifactSaveState({ kind: "saving" });
    void saveArtifactContent(tenantId, artifactId, content).then(
      (saved) => {
        if (artifactSaveStateForId.current !== artifactId) return;
        setArtifactSaveState({
          kind: "saved",
          version: saved.version,
          savedAt: Date.now(),
        });
      },
      () => {
        if (artifactSaveStateForId.current !== artifactId) return;
        setArtifactSaveState({ kind: "unsaved" });
      },
    );
  };
  const closeCanvas = useCloseCanvas();
  const toggleCanvasFocus = useToggleCanvasFocus();
  const mainRef = useRef<HTMLDivElement>(null);
  // Route changes must not inherit the previous page's scroll position.
  useScrollReset(mainRef, path);
  const pendingCount = usePendingApprovalCount(tenantId);
  const pendingChip =
    pendingCount === null
      ? undefined
      : pendingCount > 0
        ? {
            tone: "needs-you" as const,
            label: `${String(pendingCount)} waiting on you`,
          }
        : { tone: "ok" as const, label: "All caught up" };

  return (
    <div className="shell-frame">
      <Sidebar path={path} user={user} onNavigate={navigate} onSignOut={onSignOut} />
      <div className="shell-main" ref={mainRef}>
        <div className="shell-main-content">
          {routeHasNoStageTopBar(path) ? (
            <StageTopBar
              crumbs={[{ label: routeLabel(path) }]}
              {...(pendingChip !== undefined ? { chip: pendingChip } : {})}
            />
          ) : null}
          <Suspense
            fallback={
              <div className="page-fill shell-route-loading">
                <WorkbenchLoadingState />
              </div>
            }
          >
            {children}
          </Suspense>
        </div>
      </div>
      {canvasAllowed ? (
        <Suspense fallback={null}>
          <CanvasColumn
            open={canvasOpen}
            profile={canvasProfile}
            artifact={canvasArtifact}
            routine={canvasRoutine}
            focus={canvasFocus}
            onClose={closeCanvas}
            onToggleFocus={toggleCanvasFocus}
            onNavigate={navigate}
            artifactSaveState={artifactSaveState}
            onSaveArtifact={saveArtifact}
          />
        </Suspense>
      ) : null}
      <ShellContextMenu onSignOut={onSignOut} />
    </div>
  );
}
