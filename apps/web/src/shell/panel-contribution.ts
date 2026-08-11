// Panel contribution registry: page packages provide contextual panel bands;
// the shell resolves the first matching contribution for the current route.
// UI primitives stay in react-ui; this module only owns shell composition.

import type { ReactNode } from "react";

export type PanelAction = {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly onSelect: () => void;
};

export type PageBand = {
  /** SidebarPanelHeader title — string for the react-ui pin contract. */
  readonly title: string;
  readonly subtitle?: string;
  readonly settingsPath?: string;
  readonly headerActions?: readonly PanelAction[];
  readonly actions?: readonly PanelAction[];
  readonly stats?: ReactNode;
};

export type PanelRenderContext = {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
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
