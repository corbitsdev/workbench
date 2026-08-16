// The route table: one entry per screen, consumed by both the sidebar (label,
// icon) and the route switch (render), so navigation and pages cannot drift
// apart. Settings is a rail footer destination (mock chrome). Channel deep
// links (`/c/:channelId`) stay routable; Chats on the rail lands Myra via
// `/`. Approvals has no page — the Activity band owns them. `/` is the Myra
// land hop (ensure + open channel), not a Home dashboard. Agents and Skills
// are no longer rail destinations (CL-5990) — they are Settings sections;
// `/agents` and `/skills` stay routable only as redirects to their new home,
// so old links and bookmarks still land somewhere real.

import {
  Blocks,
  ChartColumn,
  Inbox,
  Library,
  MessageSquare,
  Search,
  Settings,
  SlidersHorizontal,
  Workflow,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { CHANNEL_PATH_PREFIX, isChannelPath } from "./channel-path";
import { ChatPage } from "./pages/chat-page";
import { HomeRoute } from "./pages/home-page";
import { InboxRoute } from "./pages/inbox-page";
import { InsightsRoute } from "./pages/insights-page";
import { LibraryRoute } from "./pages/library-page";
import {
  LegacyAgentsRedirect,
  LegacySkillsRedirect,
} from "./pages/legacy-settings-redirects";
import { PluginsRoute } from "./pages/plugins-page";
import { RoutinesRoute } from "./pages/routines-page";
import { SettingsRoute } from "./pages/settings-page";

/** Landing point for a session the first-login hook just provisioned a
 * personal bench for. Not one of `APP_ROUTES`: it has no sidebar entry,
 * it is only ever reached by the first-login redirect. */
export const ONBOARDING_PATH = "/onboarding";

/** Settings path — rail footer + settings page. */
export const SETTINGS_PATH = "/settings";

/**
 * Mock rail primary stack (top → spacer): Chats, Routines, Library. Inbox
 * sits below the spacer with Search / Settings / theme / avatar (composed
 * in the rail, not this set). Owner ruling (CL-5990): the rail is core
 * actions only — Agents and Skills moved into Settings. Insights left the
 * rail (CL-6081) — it stays routable via deep link and the command palette.
 */
const RAIL_PRIMARY_PATHS = [
  CHANNEL_PATH_PREFIX,
  "/routines",
  "/library",
] as const;

const RAIL_UTILITY_PATHS = ["/inbox"] as const;

export type AppRoute = {
  readonly path: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly render: (
    path: string,
    navigate: (to: string) => void,
  ) => ReactElement;
  /** False only for the one screen with no `StageTopBar` of its own — Myra
   * land (`/`) is a bare ensure+redirect hop (see `pages/home-page.tsx`)
   * with nothing in the stage to title itself while it resolves. `AppShell`
   * covers that gap generically (`shell/app-shell.tsx`) rather than home-page
   * inventing chrome for a screen that's never meant to linger. Every other
   * route titles its own stage. */
  readonly hasStageTopBar?: boolean;
};

/**
 * Matches nested product paths (`/routines/:id`, `/insights/...`, `/inbox/...`)
 * plus channel deep links. Chats also lights when Myra land (`/`) is active.
 * Other routes are exact path matches.
 */
export function matchesRoute(routePath: string, path: string): boolean {
  if (routePath === CHANNEL_PATH_PREFIX) {
    return isChannelPath(path) || path === "/";
  }
  if (
    routePath === "/routines" ||
    routePath === "/library" ||
    routePath === "/insights" ||
    routePath === "/inbox" ||
    routePath === "/agents" ||
    routePath === "/skills" ||
    routePath === SETTINGS_PATH
  ) {
    return path === routePath || path.startsWith(`${routePath}/`);
  }
  return routePath === path;
}

export const APP_ROUTES: readonly AppRoute[] = [
  {
    path: "/",
    label: "Myra",
    icon: <MessageSquare />,
    render: () => <HomeRoute />,
    hasStageTopBar: false,
  },
  {
    path: CHANNEL_PATH_PREFIX,
    label: "Chats",
    icon: <MessageSquare />,
    render: (path: string, navigate: (to: string) => void) => (
      <ChatPage path={path} navigate={navigate} />
    ),
  },
  {
    path: "/inbox",
    label: "Inbox",
    icon: <Inbox />,
    render: (path: string, navigate: (to: string) => void) => (
      <InboxRoute path={path} navigate={navigate} />
    ),
  },
  {
    path: "/routines",
    label: "Routines",
    icon: <Workflow />,
    render: (path: string, navigate: (to: string) => void) => (
      <RoutinesRoute path={path} navigate={navigate} />
    ),
  },
  {
    path: "/library",
    label: "Library",
    icon: <Library />,
    render: (path: string) => <LibraryRoute path={path} />,
  },
  {
    // Not a rail destination (see RAIL_PRIMARY_PATHS) — Agents is now a
    // Settings section. This entry only keeps old `/agents` links routable.
    path: "/agents",
    label: "Agents",
    icon: <SlidersHorizontal />,
    render: (path: string, navigate: (to: string) => void) => (
      <LegacyAgentsRedirect path={path} navigate={navigate} />
    ),
  },
  {
    // Not a rail destination — Skills is now a Settings section. This entry
    // only keeps old `/skills` links routable.
    path: "/skills",
    label: "Skills",
    icon: <SlidersHorizontal />,
    render: (path: string, navigate: (to: string) => void) => (
      <LegacySkillsRedirect path={path} navigate={navigate} />
    ),
  },
  {
    path: "/insights",
    label: "Insights",
    icon: <ChartColumn />,
    render: (path: string) => <InsightsRoute path={path} />,
  },
  {
    // Route entry only — CL-6090 builds the page; the footer link into it
    // is CL-6088's (the single-column shell rework), so this is
    // deliberately absent from RAIL_PRIMARY_PATHS / RAIL_UTILITY_PATHS /
    // NAV_ROUTES below.
    path: "/plugins",
    label: "Plugins",
    icon: <Blocks />,
    render: (path: string, navigate: (to: string) => void) => (
      <PluginsRoute path={path} navigate={navigate} />
    ),
  },
  {
    path: SETTINGS_PATH,
    label: "Settings",
    icon: <SlidersHorizontal />,
    render: (path: string, navigate: (to: string) => void) => (
      <SettingsRoute path={path} navigate={navigate} />
    ),
  },
];

function routesInOrder(paths: readonly string[]): readonly AppRoute[] {
  const byPath = new Map(APP_ROUTES.map((route) => [route.path, route]));
  return paths.flatMap((path) => {
    const route = byPath.get(path);
    return route === undefined ? [] : [route];
  });
}

/** Primary product destinations on the orange rail (above the spacer). */
export const RAIL_PRIMARY_ROUTES: readonly AppRoute[] =
  routesInOrder(RAIL_PRIMARY_PATHS);

/** Utility destinations on the rail below the spacer (Inbox). */
export const RAIL_UTILITY_ROUTES: readonly AppRoute[] =
  routesInOrder(RAIL_UTILITY_PATHS);

/**
 * Everything the rail and command palette treat as a product destination.
 * Settings stays on the rail footer (not primary) but is included here for
 * palette / shared nav helpers.
 */
export const NAV_ROUTES: readonly AppRoute[] = [
  ...RAIL_PRIMARY_ROUTES,
  ...RAIL_UTILITY_ROUTES,
  ...routesInOrder([SETTINGS_PATH]),
];

/** Search control on the rail — not a route; opens the command palette. */
export const RAIL_SEARCH = {
  id: "search",
  label: "Search",
  icon: <Search />,
} as const;

/** Settings control on the rail footer. */
export const RAIL_SETTINGS = {
  id: SETTINGS_PATH,
  label: "Settings",
  icon: <Settings />,
} as const;
