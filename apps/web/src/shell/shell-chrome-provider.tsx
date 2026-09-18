// Owns the shell chrome state that has to be visible above both the command
// palette and the shell frame: canvas state (open/profile/focus).
// CommandPaletteProvider and AppShell are siblings in app.tsx's Shell — a
// palette action that "closes the canvas" has to mutate the same state
// AppShell renders from, not a second copy scoped to AppShell's own
// subtree. This is the one place that state lives; AppShell consumes it
// through the same hooks page code already uses (`useCloseCanvas`, ...)
// plus the shell-only read (`useCanvasColumnOpen`) it needs for its own
// render.

import { useCallback, useState, type ReactNode } from "react";

import type { ProfileSubject } from "@/chat";
import {
  canvasColumnAllowed,
  clearCanvasForTenantSwitch,
  closeCanvasContent,
  initialCanvasColumnState,
  openArtifactInCanvas,
  openProfileInCanvas,
  resolveCanvasFocus,
  resolveCanvasVisibility,
  toggleCanvasFocus,
  useShellLayoutMode,
} from "@/shell/layout";
import { useBench } from "../bench-context";
import { workbenchIdFromPath, workbenchPath, isWorkbenchPath } from "../workbench-path";
import {
  CanvasAvailabilityProvider,
  type AppCanvasColumnState,
  type CanvasArtifactContent,
  type RoutinePanelSubject,
} from "./canvas-availability";

/** First pathname segment, ignoring query and hash. Nested detail under the
 * same surface (`/workflows` vs `/workflows/:id`) shares a prefix; a rail leave
 * (`/workflows` → `/insights`) does not. */
function inAppRoutePrefix(path: string): string {
  const pathname = path.split("?")[0]?.split("#")[0] ?? "";
  const trimmed = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  const slash = trimmed.indexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(0, slash);
}

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

  const [canvasState, setCanvasState] = useState<AppCanvasColumnState>(
    initialCanvasColumnState<ProfileSubject, CanvasArtifactContent, RoutinePanelSubject>,
  );

  // The last scope and rail surface we applied, adjusted during render
  // rather than from an effect — the canvas must never paint a frame
  // holding another workbench's content. The initial null→ready tenant
  // resolve is not a switch.
  const [appliedTenantId, setAppliedTenantId] = useState<string | null>(selectedTenantId);
  const routePrefix = inAppRoutePrefix(path);
  const [appliedRoutePrefix, setAppliedRoutePrefix] = useState(routePrefix);

  if (appliedTenantId !== selectedTenantId) {
    setAppliedTenantId(selectedTenantId);
    setAppliedRoutePrefix(routePrefix);
    if (appliedTenantId !== null && selectedTenantId !== null) {
      // A switch drops auxiliary canvas content and leaves any conversation
      // deep link, so the stage never keeps a foreign conversation.
      setCanvasState(clearCanvasForTenantSwitch());
      if (isWorkbenchPath(path) && workbenchIdFromPath(path) !== null) {
        // On a microtask so the hop never updates the router mid-render.
        queueMicrotask(() => navigate(workbenchPath(null)));
      }
    }
  } else if (appliedRoutePrefix !== routePrefix) {
    // Leaving a rail surface dismisses auxiliary canvas content so a compact
    // viewport that hid the column cannot resurrect it when the shell
    // expands again. Nested detail and query-only changes share a prefix.
    setAppliedRoutePrefix(routePrefix);
    setCanvasState((state) => closeCanvasContent(state));
  }

  const openProfile = useCallback((subject: ProfileSubject) => {
    setCanvasState((state) => openProfileInCanvas(state, subject));
  }, []);

  const openArtifact = useCallback((artifact: CanvasArtifactContent) => {
    setCanvasState((state) => openArtifactInCanvas(state, artifact));
  }, []);

  const openRoutine = useCallback((_subject: RoutinePanelSubject) => undefined, []);

  const closeCanvas = useCallback(() => {
    setCanvasState((state) => closeCanvasContent(state));
  }, []);

  const toggleFocus = useCallback(() => {
    setCanvasState((state) => toggleCanvasFocus(state));
  }, []);

  const canvasFocused = resolveCanvasFocus(canvasState, canvasAllowed);
  const canvasOpen = resolveCanvasVisibility(canvasState, canvasAllowed);

  return (
    <CanvasAvailabilityProvider
      allowed={canvasAllowed}
      open={canvasOpen}
      profile={canvasState.profile}
      artifact={canvasState.artifact}
      routine={canvasState.routine}
      focus={canvasFocused}
      openProfile={openProfile}
      openArtifact={openArtifact}
      openRoutine={openRoutine}
      toggleFocus={toggleFocus}
      close={closeCanvas}
    >
      {children}
    </CanvasAvailabilityProvider>
  );
}
