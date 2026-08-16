// Column 1: brand-orange global rail matching the shell mock 1:1.
// Primary product pages above a spacer; Search / Inbox / Settings / theme /
// avatar below. Surfaces compose `@corbits/react-ui` SidebarRail + Avatar +
// ThemeToggle + CorbitsMark.

import {
  Avatar,
  CorbitsMark,
  SidebarRail,
  ThemeToggle,
} from "@corbits/react-ui";
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

function FooterIconButton({
  label,
  active,
  onClick,
  children,
}: {
  readonly label: string;
  readonly active?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="shell-rail-footer-btn"
      aria-label={label}
      title={label}
      aria-current={active === true ? "page" : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function Rail({
  path,
  onNavigate,
  user,
  showLabels = false,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
  readonly user: SessionUser;
  /** Mock is icon+tooltip only; captions are opt-in for wide breakpoints. */
  readonly showLabels?: boolean;
}) {
  const primaryActive = RAIL_PRIMARY_ROUTES.find((route) =>
    matchesRoute(route.path, path),
  );
  const inboxActive = RAIL_UTILITY_ROUTES.some((route) =>
    matchesRoute(route.path, path),
  );
  const settingsActive = matchesRoute(SETTINGS_PATH, path);
  const activeId = primaryActive?.path ?? "";

  const items = RAIL_PRIMARY_ROUTES.map(routeItem);

  function handleSelect(id: string) {
    // Chats rail lands Myra (ensure + open), not a bare /c prefix.
    if (id === CHANNEL_PATH_PREFIX) {
      onNavigate("/");
      return;
    }
    onNavigate(id);
  }

  const inboxRoute = RAIL_UTILITY_ROUTES[0];

  return (
    <div
      className={
        showLabels
          ? "shell-brand-rail-column shell-brand-rail-column--labels"
          : "shell-brand-rail-column"
      }
    >
      <button
        type="button"
        className="shell-rail-mark"
        aria-label="Workbench home"
        title="Workbench"
        onClick={() => onNavigate("/")}
      >
        <CorbitsMark decorative className="shell-rail-mark-svg" />
      </button>
      <SidebarRail
        label="Workbench"
        className="shell-brand-rail"
        showLabels={showLabels}
        activeId={activeId}
        items={items}
        onSelect={handleSelect}
        footer={
          <div className="shell-rail-footer">
            <FooterIconButton
              label={RAIL_SEARCH.label}
              onClick={() => requestOpenCommandPalette()}
            >
              {RAIL_SEARCH.icon}
            </FooterIconButton>
            {inboxRoute !== undefined ? (
              <FooterIconButton
                label={inboxRoute.label}
                active={inboxActive}
                onClick={() => onNavigate(inboxRoute.path)}
              >
                {inboxRoute.icon}
              </FooterIconButton>
            ) : null}
            <FooterIconButton
              label={RAIL_SETTINGS.label}
              active={settingsActive}
              onClick={() => onNavigate(SETTINGS_PATH)}
            >
              {RAIL_SETTINGS.icon}
            </FooterIconButton>
            <ThemeToggle />
            <button
              type="button"
              className="shell-rail-avatar-btn"
              aria-label={`${user.name} · Settings`}
              title={`${user.name} · Settings`}
              data-ctx-account=""
              onClick={() => onNavigate(SETTINGS_PATH)}
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
    </div>
  );
}
