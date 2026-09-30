// Canvas state is NOT owned here — see `shell-chrome-provider.tsx` for why
// it has to be visible to the command palette too.

import { lazy, Suspense, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button } from "@corbits/react-ui";
import { PanelLeft } from "@/lib/icons";
import type { ArtifactSaveState } from "@/library";

import { WorkbenchLoadingState } from "@/chat";

import { usePendingApprovalCount } from "../pending-approvals";
import { useBench } from "../bench-context";
import { useNavigate } from "../navigation";
import { saveArtifactContent } from "./library-artifacts";
import { APP_ROUTES, matchesRoute } from "../routes";
import type { SessionUser } from "../session";
import { isWorkbenchPath } from "../workbench-path";
import { StageTopBar } from "./stage-top-bar";
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
import { isNarrow, SidebarToggleContext, useIsNarrow } from "./sidebar-toggle";
import { ShellContextMenu } from "./context-menu/shell-context-menu";
import { FirstRunTour } from "./first-run-tour";
import "./shell-narrow.css";

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

/** Route changes must not inherit the previous page's scroll position. Keyed
 * on the path, so it remounts per route and resets the scroll container as
 * its ref attaches. */
function ScrollToTop({
  containerRef,
}: {
  readonly containerRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <span
      hidden
      ref={() => {
        if (containerRef.current !== null) containerRef.current.scrollTop = 0;
      }}
    />
  );
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

  // Carried with the id it belongs to, so a stale "Saved · v3" can never
  // leak into a newly opened artifact.
  const [savedFor, setSavedFor] = useState<{
    readonly id: string;
    readonly state: ArtifactSaveState;
  } | null>(null);
  const editableArtifact =
    canvasArtifact !== null && canvasArtifact.rendererKind === "doc" ? canvasArtifact : null;
  const artifactSaveState: ArtifactSaveState =
    editableArtifact === null
      ? { kind: "read-only" }
      : savedFor?.id === editableArtifact.id
        ? savedFor.state
        : editableArtifact.canEdit === true
          ? { kind: "unsaved" }
          : { kind: "read-only" };

  const saveArtifact = (content: string) => {
    if (tenantId === null || editableArtifact === null) return;
    const artifactId = editableArtifact.id;
    const keepIfCurrent = (state: ArtifactSaveState) => {
      setSavedFor((previous) =>
        previous === null || previous.id === artifactId ? { id: artifactId, state } : previous,
      );
    };
    setSavedFor({ id: artifactId, state: { kind: "saving" } });
    void saveArtifactContent(tenantId, artifactId, content).then(
      (saved) => {
        keepIfCurrent({ kind: "saved", version: saved.version, savedAt: Date.now() });
      },
      () => {
        keepIfCurrent({ kind: "unsaved" });
      },
    );
  };
  const closeCanvas = useCloseCanvas();
  const toggleCanvasFocus = useToggleCanvasFocus();
  const mainRef = useRef<HTMLDivElement>(null);
  // Keyed by path so any navigation closes the phone-width sidebar.
  const [sidebarOpenFor, setSidebarOpenFor] = useState<string | null>(null);
  const sidebarOpen = sidebarOpenFor === path;
  // Desktop collapse. The chat and home screens carry no `StageTopBar`, so
  // they always show the sidebar rather than leave no way back.
  const [collapsed, setCollapsed] = useState(false);
  const narrow = useIsNarrow();
  const collapsible = path !== "/" && !isWorkbenchPath(path);
  const sidebarCollapsed = collapsed && collapsible;
  const toggleSidebar = () => {
    if (isNarrow()) setSidebarOpenFor(sidebarOpen ? null : path);
    else setCollapsed(!collapsed);
  };
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarOpenFor(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);
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
    <SidebarToggleContext
      value={{ expanded: narrow ? sidebarOpen : !sidebarCollapsed, toggle: toggleSidebar }}
    >
      <div
        className="shell-frame"
        data-sidebar-open={sidebarOpen}
        data-sidebar-collapsed={sidebarCollapsed}
      >
        <Button
          variant="ghost"
          size="sm"
          className="shell-sidebar-toggle"
          aria-label="Toggle sidebar"
          aria-expanded={sidebarOpen}
          onClick={toggleSidebar}
        >
          <PanelLeft />
        </Button>
        <div
          className="shell-sidebar-scrim"
          onClick={() => setSidebarOpenFor(null)}
          aria-hidden="true"
        />
        <Sidebar path={path} onNavigate={navigate} />
        <div className="shell-main" ref={mainRef}>
          <ScrollToTop key={path} containerRef={mainRef} />
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
        <FirstRunTour userId={user.id} />
      </div>
    </SidebarToggleContext>
  );
}
