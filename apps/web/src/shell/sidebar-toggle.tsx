// One handler for the sidebar toggle: `AppShell` owns the state and the
// phone-width button; the desktop button lives in each page's `StageTopBar`.

import { createContext, useContext, useSyncExternalStore } from "react";
import { Button } from "@corbits/react-ui";
import { PanelLeft } from "@/lib/icons";

export type SidebarToggle = {
  readonly expanded: boolean;
  readonly toggle: () => void;
};

export const SidebarToggleContext = createContext<SidebarToggle | null>(null);

// Mirrors the `max-width: 860px` breakpoint in shell-narrow.css.
const NARROW_QUERY = "(max-width: 860px)";

export function subscribeNarrow(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function isNarrow(): boolean {
  return window.matchMedia(NARROW_QUERY).matches;
}

export function useIsNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, isNarrow);
}

/** The desktop sidebar toggle; phone width uses the shell's fixed button. */
export function StageSidebarToggle() {
  const sidebar = useContext(SidebarToggleContext);
  if (sidebar === null) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="stage-sidebar-toggle"
      aria-label="Toggle sidebar"
      aria-expanded={sidebar.expanded}
      onClick={sidebar.toggle}
    >
      <PanelLeft />
    </Button>
  );
}
