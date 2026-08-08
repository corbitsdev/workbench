// Column 1: the global button rail. A thin wrapper around
// `@corbits/react-ui`'s `SidebarRail` — the rail's anatomy (56px, icon-only
// buttons with a hover/focus tooltip carrying the accessible label) is the
// library's, not ours; this file only turns the route table into the
// `SidebarRailItem[]` shape the rail expects.

import { SidebarRail } from "@corbits/react-ui";

import { NAV_ROUTES, matchesRoute, type AppRoute } from "../routes";

function railItemId(route: AppRoute): string {
  return route.path;
}

export function Rail({
  path,
  onNavigate,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
}) {
  const active = NAV_ROUTES.find((route) => matchesRoute(route.path, path));
  return (
    <SidebarRail
      label="Workbench"
      items={NAV_ROUTES.map((route) => ({
        id: railItemId(route),
        label: route.label,
        icon: route.icon,
      }))}
      activeId={active === undefined ? "" : railItemId(active)}
      onSelect={onNavigate}
    />
  );
}
