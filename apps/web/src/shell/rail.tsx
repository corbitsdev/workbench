// Column 1: the global rail. Answers "where am I in the product, and which
// bench am I in" — the page icons never change with navigation or with the
// selected bench, and neither does this column's width.
//
// The caption-under-icon rail landed in `@corbits/react-ui`'s `SidebarRail`
// as its `showLabels` option, so the rail is now the library component with
// labels on — the hand-rolled item markup it temporarily mirrored is gone.
// The footer still composes the bench switcher and identity docks the rail
// needs below the page icons.

import { SidebarRail } from "@corbits/react-ui";

import { NAV_ROUTES, matchesRoute, type AppRoute } from "../routes";
import type { SessionUser } from "../session";
import { BenchDock, RailIdentity } from "./docks";

export function Rail({
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
  // `SidebarRail` flags the item whose id equals `activeId`; the nav routes
  // own prefix matching (e.g. /chat/:channelId lights the Chat item), so the
  // active id is resolved here rather than left to an exact path compare.
  const activeRoute = NAV_ROUTES.find((route) =>
    matchesRoute(route.path, path),
  );

  return (
    <SidebarRail
      label="Workbench"
      showLabels
      activeId={activeRoute?.path ?? ""}
      items={NAV_ROUTES.map((route: AppRoute) => ({
        id: route.path,
        label: route.label,
        icon: route.icon,
      }))}
      onSelect={onNavigate}
      footer={
        <>
          <BenchDock />
          <RailIdentity path={path} user={user} onSignOut={onSignOut} />
        </>
      }
    />
  );
}
