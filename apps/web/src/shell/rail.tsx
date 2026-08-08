// Column 1: the global rail. Answers "where am I in the product, and which
// bench am I in" — the page icons never change with navigation or with the
// selected bench, and neither does this column's width.
//
// `@corbits/react-ui`'s `SidebarRail` is icon-only by design (see its own
// doc comment), so a caption-under-icon rail isn't available from the
// published version pinned in `package.json` yet — the item markup here
// intentionally mirrors that component's anatomy (`data-slot` values
// included, since `focus-rescue.ts` reaches for `sidebar-rail-item` by that
// contract) so a future bump to a version that grows a `showLabels` option
// is a drop-in swap, not a rewrite.

import { NAV_ROUTES, matchesRoute, type AppRoute } from "../routes";
import type { SessionUser } from "../session";
import { BenchDock, RailIdentity } from "./docks";

function railItemId(route: AppRoute): string {
  return route.path;
}

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
  return (
    <nav data-slot="sidebar-rail" aria-label="Workbench" className="shell-rail">
      <ul className="shell-rail-nav">
        {NAV_ROUTES.map((route) => {
          const active = matchesRoute(route.path, path);
          return (
            <li key={route.path}>
              <button
                type="button"
                data-slot="sidebar-rail-item"
                aria-current={active ? "page" : undefined}
                className="shell-rail-item"
                onClick={() => onNavigate(railItemId(route))}
              >
                <span className="shell-rail-item-icon">{route.icon}</span>
                <span className="shell-rail-item-label">{route.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="shell-rail-footer">
        <BenchDock />
        <RailIdentity path={path} user={user} onSignOut={onSignOut} />
      </div>
    </nav>
  );
}
