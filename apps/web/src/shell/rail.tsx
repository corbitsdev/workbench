// Column 1: brand-orange global rail matching the shell mock. Product pages
// sit above a spacer; Search / Inbox / Settings / theme / avatar sit below.
// Surfaces compose `@corbits/react-ui` SidebarRail + Avatar + ThemeToggle.

import { Avatar, SidebarRail, ThemeToggle } from "@corbits/react-ui";
import type { ReactNode } from "react";

import { CHANNEL_PATH_PREFIX } from "../channel-path";
import { requestOpenCommandPalette } from "../command-palette-events";
import {
  matchesRoute,
  RAIL_PRIMARY_ROUTES,
  RAIL_SEARCH,
  RAIL_SETTINGS,
  RAIL_UTILITY_ROUTES,
  SETTINGS_PATH,
  type AppRoute,
} from "../routes";
import type { SessionUser } from "../session";
import { initialsOf } from "./docks";

function routeItem(route: AppRoute): {
  id: string;
  label: string;
  icon: ReactNode;
} {
  return {
    id: route.path,
    label: route.label,
    icon: route.icon,
  };
}

export function Rail({
  path,
  onNavigate,
  user,
  onSignOut,
  showLabels = true,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
  readonly user: SessionUser;
  readonly onSignOut: () => void;
  readonly showLabels?: boolean;
}) {
  const primaryActive =
    RAIL_PRIMARY_ROUTES.find((route) => matchesRoute(route.path, path)) ??
    RAIL_UTILITY_ROUTES.find((route) => matchesRoute(route.path, path));

  const settingsActive = matchesRoute(SETTINGS_PATH, path);
  const activeId = settingsActive ? SETTINGS_PATH : (primaryActive?.path ?? "");

  const items = [
    ...RAIL_PRIMARY_ROUTES.map(routeItem),
    routeItem({
      path: RAIL_SEARCH.id,
      label: RAIL_SEARCH.label,
      icon: RAIL_SEARCH.icon,
      render: () => <></>,
    }),
    ...RAIL_UTILITY_ROUTES.map(routeItem),
    {
      id: RAIL_SETTINGS.id,
      label: RAIL_SETTINGS.label,
      icon: RAIL_SETTINGS.icon,
    },
  ];

  function handleSelect(id: string) {
    if (id === RAIL_SEARCH.id) {
      requestOpenCommandPalette();
      return;
    }
    // Channels rail lands Myra (ensure + open), not a bare /c prefix.
    if (id === CHANNEL_PATH_PREFIX) {
      onNavigate("/");
      return;
    }
    onNavigate(id);
  }

  return (
    <SidebarRail
      label="Workbench"
      className="shell-brand-rail"
      showLabels={showLabels}
      activeId={activeId}
      items={items}
      onSelect={handleSelect}
      footer={
        <div className="shell-rail-footer">
          <ThemeToggle />
          <button
            type="button"
            className="shell-rail-avatar-btn"
            aria-label={`${user.name} · Settings`}
            title={`${user.name} · Settings`}
            onClick={() => onNavigate(SETTINGS_PATH)}
            onContextMenu={(event) => {
              event.preventDefault();
              onSignOut();
            }}
          >
            <Avatar
              initials={initialsOf(user.name)}
              label={user.name}
              size="sm"
              tone="neutral"
            />
          </button>
        </div>
      }
    />
  );
}
