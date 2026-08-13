// Canvas host surface for stage content: whether the shell has room for the
// fourth column, and how main-stage chat opens auxiliary canvas content
// (profiles) without owning the canvas column itself.

import { createContext, useContext, type ReactNode } from "react";
import type { ProfileSubject } from "@corbits/chat-ui";

export type CanvasHost = {
  readonly allowed: boolean;
  readonly openProfile: (subject: ProfileSubject) => void;
  readonly closeProfile: () => void;
};

const CanvasHostContext = createContext<CanvasHost>({
  allowed: false,
  openProfile: () => undefined,
  closeProfile: () => undefined,
});

export function CanvasAvailabilityProvider({
  allowed,
  openProfile,
  closeProfile,
  children,
}: {
  readonly allowed: boolean;
  readonly openProfile: (subject: ProfileSubject) => void;
  readonly closeProfile: () => void;
  readonly children: ReactNode;
}) {
  return (
    <CanvasHostContext.Provider value={{ allowed, openProfile, closeProfile }}>
      {children}
    </CanvasHostContext.Provider>
  );
}

export function useCanvasColumnAvailable(): boolean {
  return useContext(CanvasHostContext).allowed;
}

export function useOpenProfileInCanvas(): (subject: ProfileSubject) => void {
  return useContext(CanvasHostContext).openProfile;
}

/** Closes whatever auxiliary content the canvas is currently showing — the
 * command palette's "Close canvas" action uses this same seam. */
export function useCloseCanvas(): () => void {
  return useContext(CanvasHostContext).closeProfile;
}
