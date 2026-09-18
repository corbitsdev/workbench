// Canvas host surface for stage content: whether the shell has room for the
// fourth column, how main-stage chat opens auxiliary canvas content
// (profiles, artifacts) without owning the canvas column itself, and — for
// AppShell's own render, which no longer owns this state — what the canvas
// column is actually showing right now.

import { useContext, type ReactNode } from "react";
import type { ProfileSubject } from "@/chat";

import { CanvasHostContext } from "./canvas-host-context";
import type {
  AppCanvasColumnState,
  CanvasArtifactContent,
  CanvasHost,
  RoutinePanelSubject,
} from "./canvas-host-context";

export { CanvasHostContext };
export type { AppCanvasColumnState, CanvasArtifactContent, CanvasHost, RoutinePanelSubject };

export function CanvasAvailabilityProvider({
  allowed,
  open,
  profile,
  artifact,
  routine,
  focus,
  openProfile,
  openArtifact,
  openRoutine,
  toggleFocus,
  close,
  children,
}: {
  readonly allowed: boolean;
  readonly open: boolean;
  readonly profile: ProfileSubject | null;
  readonly artifact: CanvasArtifactContent | null;
  readonly routine: RoutinePanelSubject | null;
  readonly focus: boolean;
  readonly openProfile: (subject: ProfileSubject) => void;
  readonly openArtifact: (artifact: CanvasArtifactContent) => void;
  readonly openRoutine: (subject: RoutinePanelSubject) => void;
  readonly toggleFocus: () => void;
  readonly close: () => void;
  readonly children: ReactNode;
}) {
  return (
    <CanvasHostContext.Provider
      value={{
        allowed,
        open,
        profile,
        artifact,
        routine,
        focus,
        openProfile,
        openArtifact,
        openRoutine,
        toggleFocus,
        close,
      }}
    >
      {children}
    </CanvasHostContext.Provider>
  );
}

export function useCanvasColumnAvailable(): boolean {
  return useContext(CanvasHostContext).allowed;
}

/** Whether the canvas column is actually showing right now — AppShell's own
 * read for the `CanvasColumn`'s `open` prop. */
export function useCanvasColumnOpen(): boolean {
  return useContext(CanvasHostContext).open;
}

/** The subject the canvas column is showing, if any — AppShell's own read
 * for the `CanvasColumn`'s `profile` prop. */
export function useCanvasColumnProfile(): ProfileSubject | null {
  return useContext(CanvasHostContext).profile;
}

/** The typed artifact content the canvas column is showing, if any —
 * AppShell's own read for the `CanvasColumn`'s `artifact` prop. */
export function useCanvasColumnArtifact(): CanvasArtifactContent | null {
  return useContext(CanvasHostContext).artifact;
}

/** The routine pane subject the canvas column is showing, if any —
 * AppShell's own read for the `CanvasColumn`'s `routine` prop. */
export function useCanvasColumnRoutine(): RoutinePanelSubject | null {
  return useContext(CanvasHostContext).routine;
}

/** Whether the canvas is in its dominant focus mode right now. */
export function useCanvasColumnFocus(): boolean {
  return useContext(CanvasHostContext).focus;
}

export function useOpenProfileInCanvas(): (subject: ProfileSubject) => void {
  return useContext(CanvasHostContext).openProfile;
}

/** Opens (or replaces) the canvas's typed artifact pane — the seam a chat
 * artifact chip or the Library page's "open in canvas" affordance calls. */
export function useOpenArtifactInCanvas(): (artifact: CanvasArtifactContent) => void {
  return useContext(CanvasHostContext).openArtifact;
}

/** Opens (or replaces) the canvas's routine pane — the workbench header's
 * "New routine" action, the `/workflows` page's own create button, and an
 * existing routine's own "Edit" hop all call this. `routineId: null` starts
 * a brand-new routine; a real id opens that routine for editing. */
export function useOpenRoutineInCanvas(): (subject: RoutinePanelSubject) => void {
  return useContext(CanvasHostContext).openRoutine;
}

/** Toggles canvas-dominant focus — the mock's `data-action="canvas-focus"`
 * cycle control. A no-op when the canvas has nothing open. */
export function useToggleCanvasFocus(): () => void {
  return useContext(CanvasHostContext).toggleFocus;
}

/** Closes whatever auxiliary content the canvas is currently showing — the
 * command palette's "Close canvas" action, and the canvas pane's own close
 * button, both use this same seam. */
export function useCloseCanvas(): () => void {
  return useContext(CanvasHostContext).close;
}
