// Whether the shell has room for the canvas column. Channel routes use this
// to decide between rendering chat in the main pane (compact/narrow) and
// leaving the conversation to the canvas (expanded).

import { createContext, useContext, type ReactNode } from "react";

const CanvasAvailabilityContext = createContext(false);

export function CanvasAvailabilityProvider({
  allowed,
  children,
}: {
  readonly allowed: boolean;
  readonly children: ReactNode;
}) {
  return (
    <CanvasAvailabilityContext.Provider value={allowed}>
      {children}
    </CanvasAvailabilityContext.Provider>
  );
}

export function useCanvasColumnAvailable(): boolean {
  return useContext(CanvasAvailabilityContext);
}
