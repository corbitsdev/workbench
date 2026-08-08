// Column 2: the contextual panel. Slack-esque — the active page's name up
// top, the page list as full-label rows (the rail only ever shows an icon),
// and the bench/identity docks pinned to the bottom. Built from
// `@corbits/react-ui`'s `SidebarPanel` family; this file only supplies the
// workbench-specific content that fills those slots.

import {
  SidebarItemRow,
  SidebarPanel,
  SidebarPanelBody,
  SidebarPanelFooter,
  SidebarPanelHeader,
  SidebarPanelSection,
  useSidebarPanel,
} from "@corbits/react-ui";

import { NAV_ROUTES, matchesRoute } from "../routes";
import { BenchDock, IdentityDock } from "./docks";
import type { SessionUser } from "../session";

const PAGES_SECTION_ID = "pages";

export function ContextualPanel({
  path,
  onNavigate,
  user,
  onSignOut,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
  readonly user: SessionUser;
  readonly onSignOut: () => void;
}) {
  const active = NAV_ROUTES.find((route) => matchesRoute(route.path, path));
  const activePageId = active?.path ?? path;
  // Section folding and the page-swap animation come from the panel's own
  // hook; its `selectedId` deliberately does not, because the URL already
  // says which page is selected and a second answer to that question is how
  // the two drift apart.
  const {
    isSectionCollapsed,
    toggleSection,
    panelKey,
    panelTransitionClassName,
  } = useSidebarPanel({ activePageId });
  return (
    <SidebarPanel
      data-testid="shell-contextual-panel"
      style={{ width: "var(--shell-contextual-width)" }}
    >
      <SidebarPanelHeader title={active?.label ?? "Workbench"} />
      <SidebarPanelBody key={panelKey} className={panelTransitionClassName}>
        <SidebarPanelSection
          label="Pages"
          collapsed={isSectionCollapsed(PAGES_SECTION_ID)}
          onToggleCollapse={() => toggleSection(PAGES_SECTION_ID)}
        >
          {NAV_ROUTES.map((route) => (
            <SidebarItemRow
              key={route.path}
              name={route.label}
              leading={route.icon}
              selected={matchesRoute(route.path, path)}
              onSelect={() => onNavigate(route.path)}
            />
          ))}
        </SidebarPanelSection>
      </SidebarPanelBody>
      <SidebarPanelFooter className="shell-contextual-footer">
        <BenchDock />
        <IdentityDock path={path} user={user} onSignOut={onSignOut} />
      </SidebarPanelFooter>
    </SidebarPanel>
  );
}
