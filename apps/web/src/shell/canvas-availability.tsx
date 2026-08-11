// Canvas host surface for stage content: whether the shell has room for the
// fourth column, and how main-stage chat opens auxiliary canvas content
// (profiles) without owning the canvas column itself.

import { createContext, useContext, type ReactNode } from "react";
import type { ProfileSubject } from "@corbits/chat-ui";

export type CanvasHost = {
  readonly allowed: boolean;
  readonly openProfile: (subject: ProfileSubject) => void;
};

const CanvasHostContext = createContext<CanvasHost>({
  allowed: false,
  openProfile: () => undefined,
});

export function CanvasAvailabilityProvider({
  allowed,
  openProfile,
  children,
}: {
  readonly allowed: boolean;
  readonly openProfile: (subject: ProfileSubject) => void;
  readonly children: ReactNode;
}) {
  return (
    <CanvasHostContext.Provider value={{ allowed, openProfile }}>
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
