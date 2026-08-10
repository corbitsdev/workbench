// Route-aware contributions for the shell contextual panel. Page modules
// register bands here; the shell resolves the first match for the current
// path and never hardcodes per-page content. Workbench-specific — lives next
// to the panel, not in a separate package. UI primitives stay in react-ui.

import type { ReactNode } from "react";

export type PanelAction = {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
};

export type PageBand = {
  /** SidebarPanelHeader title — string for the react-ui pin contract. */
  readonly title: string;
  readonly subtitle?: string;
  readonly settingsPath?: string;
  readonly actions?: readonly PanelAction[];
  readonly stats?: ReactNode;
};

export type PanelRenderContext = {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
  /**
   * Open a channel into the canvas without leaving the current page. Channel
   * rows in the panel call this instead of navigating so a user on /library can
   * pop a conversation open in column 4 and stay where they are.
   */
  readonly onOpenInCanvas: (channelId: string) => void;
};

export type PanelContribution = {
  readonly id: string;
  readonly match: (path: string) => boolean;
  readonly pageBand: (ctx: PanelRenderContext) => PageBand;
  readonly pageSpecific?: (ctx: PanelRenderContext) => ReactNode;
};

export type PanelRegistry = {
  readonly register: (contribution: PanelContribution) => void;
  readonly resolve: (path: string) => PanelContribution | null;
  readonly list: () => readonly PanelContribution[];
};

export function createPanelRegistry(
  initial: readonly PanelContribution[] = [],
): PanelRegistry {
  const contributions: PanelContribution[] = [...initial];
  return {
    register(contribution) {
      const existing = contributions.findIndex((c) => c.id === contribution.id);
      if (existing >= 0) {
        contributions[existing] = contribution;
        return;
      }
      contributions.push(contribution);
    },
    resolve(path) {
      for (const contribution of contributions) {
        if (contribution.match(path)) return contribution;
      }
      return null;
    },
    list() {
      return contributions;
    },
  };
}

/** Module-level registry the web shell and page modules share. */
export const panelRegistry = createPanelRegistry();

export function registerPanelContribution(
  contribution: PanelContribution,
): void {
  panelRegistry.register(contribution);
}

export function resolvePanelContribution(
  path: string,
): PanelContribution | null {
  return panelRegistry.resolve(path);
}
