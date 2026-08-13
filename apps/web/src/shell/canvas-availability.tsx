// Canvas host surface for stage content: whether the shell has room for the
// fourth column, how main-stage chat opens auxiliary canvas content
// (profiles) without owning the canvas column itself, and — for AppShell's
// own render, which no longer owns this state — what the canvas column is
// actually showing right now.

import { createContext, useContext, type ReactNode } from "react";
import type { ProfileSubject } from "@corbits/chat-ui";

export type CanvasHost = {
  readonly allowed: boolean;
  readonly open: boolean;
  readonly profile: ProfileSubject | null;
  readonly openProfile: (subject: ProfileSubject) => void;
  readonly closeProfile: () => void;
};

const CanvasHostContext = createContext<CanvasHost>({
  allowed: false,
  open: false,
  profile: null,
  openProfile: () => undefined,
  closeProfile: () => undefined,
});

export function CanvasAvailabilityProvider({
  allowed,
  open,
  profile,
  openProfile,
  closeProfile,
  children,
}: {
  readonly allowed: boolean;
  readonly open: boolean;
  readonly profile: ProfileSubject | null;
  readonly openProfile: (subject: ProfileSubject) => void;
  readonly closeProfile: () => void;
  readonly children: ReactNode;
}) {
  return (
    <CanvasHostContext.Provider
      value={{ allowed, open, profile, openProfile, closeProfile }}
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

export function useOpenProfileInCanvas(): (subject: ProfileSubject) => void {
  return useContext(CanvasHostContext).openProfile;
}

/** Closes whatever auxiliary content the canvas is currently showing — the
 * command palette's "Close canvas" action uses this same seam. */
export function useCloseCanvas(): () => void {
  return useContext(CanvasHostContext).closeProfile;
}
