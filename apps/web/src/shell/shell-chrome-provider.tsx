// Owns the shell chrome state that has to be visible above both the command
// palette and the shell frame: canvas state (open/profile/focus).
// CommandPaletteProvider and AppShell are siblings in app.tsx's Shell — a
// palette action that "closes the canvas" has to mutate the same state
// AppShell renders from, not a second copy scoped to AppShell's own
// subtree. This is the one place that state lives; AppShell consumes it
// through the same hooks page code already uses (`useCloseCanvas`, ...)
// plus the shell-only read (`useCanvasColumnOpen`) it needs for its own
// render.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { ProfileSubject } from "@corbits/chat-ui";
import {
  canvasColumnAllowed,
  clearCanvasForTenantSwitch,
  closeCanvasContent,
  initialCanvasColumnState,
  openArtifactInCanvas,
  openProfileInCanvas,
  openRoutineInCanvas,
  resolveCanvasFocus,
  resolveCanvasVisibility,
  toggleCanvasFocus,
  useShellLayoutMode,
} from "@corbits/shell-layout";
import { useBench } from "../bench-context";
import {
  workbenchIdFromPath,
  workbenchPath,
  isWorkbenchPath,
} from "../workbench-path";
import {
  CanvasAvailabilityProvider,
  type AppCanvasColumnState,
  type CanvasArtifactContent,
  type RoutinePanelSubject,
} from "./canvas-availability";

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
    initialCanvasColumnState<
      ProfileSubject,
      CanvasArtifactContent,
      RoutinePanelSubject
    >,
  );

  // Tracks the last workbench scope we applied so a real switch (A→B) can
  // drop canvas state without treating the initial null→ready resolve as a
  // switch.
  const previousTenantIdRef = useRef<string | null>(selectedTenantId);

  // A switch clears auxiliary canvas content and leaves any conversation
  // deep link so the stage does not keep a foreign conversation under the
  // new scope.
  useEffect(() => {
    const previousTenantId = previousTenantIdRef.current;
    if (
      previousTenantId !== null &&
      selectedTenantId !== null &&
      previousTenantId !== selectedTenantId
    ) {
      previousTenantIdRef.current = selectedTenantId;
      setCanvasState(clearCanvasForTenantSwitch());
      if (isWorkbenchPath(path) && workbenchIdFromPath(path) !== null) {
        navigate(workbenchPath(null));
      }
      return;
    }
    previousTenantIdRef.current = selectedTenantId;
  }, [path, selectedTenantId, navigate]);

  const openProfile = useCallback((subject: ProfileSubject) => {
    setCanvasState((state) => openProfileInCanvas(state, subject));
  }, []);

  const openArtifact = useCallback((artifact: CanvasArtifactContent) => {
    setCanvasState((state) => openArtifactInCanvas(state, artifact));
  }, []);

  const openRoutine = useCallback((subject: RoutinePanelSubject) => {
    setCanvasState((state) => openRoutineInCanvas(state, subject));
  }, []);

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
