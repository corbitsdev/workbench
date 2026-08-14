// Canvas host surface for stage content: whether the shell has room for the
// fourth column, how main-stage chat opens auxiliary canvas content
// (profiles, artifacts) without owning the canvas column itself, and — for
// AppShell's own render, which no longer owns this state — what the canvas
// column is actually showing right now.

import { createContext, useContext, type ReactNode } from "react";
import type { ProfileSubject } from "@corbits/chat-ui";
import type { CanvasArtifactContent } from "./canvas-column-state";

export type CanvasHost = {
  readonly allowed: boolean;
  readonly open: boolean;
  readonly profile: ProfileSubject | null;
  readonly artifact: CanvasArtifactContent | null;
  readonly focus: boolean;
  readonly openProfile: (subject: ProfileSubject) => void;
  readonly openArtifact: (artifact: CanvasArtifactContent) => void;
  readonly toggleFocus: () => void;
  /** Closes whichever content the canvas currently shows (profile or
   * artifact) and drops focus — one seam regardless of what's open. */
  readonly close: () => void;
};

const CanvasHostContext = createContext<CanvasHost>({
  allowed: false,
  open: false,
  profile: null,
  artifact: null,
  focus: false,
  openProfile: () => undefined,
  openArtifact: () => undefined,
  toggleFocus: () => undefined,
  close: () => undefined,
});

export function CanvasAvailabilityProvider({
  allowed,
  open,
  profile,
  artifact,
  focus,
  openProfile,
  openArtifact,
  toggleFocus,
  close,
  children,
}: {
  readonly allowed: boolean;
  readonly open: boolean;
  readonly profile: ProfileSubject | null;
  readonly artifact: CanvasArtifactContent | null;
  readonly focus: boolean;
  readonly openProfile: (subject: ProfileSubject) => void;
  readonly openArtifact: (artifact: CanvasArtifactContent) => void;
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
        focus,
        openProfile,
        openArtifact,
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

/** Whether the canvas is in its dominant focus mode right now. */
export function useCanvasColumnFocus(): boolean {
  return useContext(CanvasHostContext).focus;
}

export function useOpenProfileInCanvas(): (subject: ProfileSubject) => void {
  return useContext(CanvasHostContext).openProfile;
}

/** Opens (or replaces) the canvas's typed artifact pane — the seam a chat
 * artifact chip or the Library page's "open in canvas" affordance calls. */
export function useOpenArtifactInCanvas(): (
  artifact: CanvasArtifactContent,
) => void {
  return useContext(CanvasHostContext).openArtifact;
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
