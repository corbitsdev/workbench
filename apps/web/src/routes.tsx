// The route table: one entry per screen, consumed by both the sidebar (label,
// icon) and the route switch (render), so navigation and pages cannot drift
// apart. Settings is a rail footer destination (mock chrome). Channel deep
// links (`/c/:channelId`) stay routable; Channels on the rail lands Myra via
// `/`. Approvals has no page — the Activity band owns them. `/` is the Myra
// land hop (ensure + open channel), not a Home dashboard.

import {
  Bot,
  ChartColumn,
  Inbox,
  Library,
  MessageSquare,
  Search,
  Settings,
  SlidersHorizontal,
  Wand2,
  Workflow,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { CHANNEL_PATH_PREFIX, isChannelPath } from "./channel-path";
import { AgentsRoute } from "./pages/agents-page";
import { ChatPage } from "./pages/chat-page";
import { HomeRoute } from "./pages/home-page";
import { InboxRoute } from "./pages/inbox-page";
import { InsightsRoute } from "./pages/insights-page";
import { LibraryRoute } from "./pages/library-page";
import { RoutinesRoute } from "./pages/routines-page";
import { SettingsRoute } from "./pages/settings-page";
import { SkillsRoute } from "./pages/skills-page";

/** Landing point for a session the first-login hook just provisioned a
 * personal bench for. Not one of `APP_ROUTES`: it has no sidebar entry,
 * it is only ever reached by the first-login redirect. */
export const ONBOARDING_PATH = "/onboarding";

/** Settings path — rail footer + settings page. */
export const SETTINGS_PATH = "/settings";

/**
 * Mock rail primary stack (top → spacer): Channels, Routines, Library,
 * Agents, Skills, Insights. Inbox sits below the spacer with Search /
 * Settings / theme / avatar (composed in the rail, not this set).
 */
const RAIL_PRIMARY_PATHS = [
  CHANNEL_PATH_PREFIX,
  "/routines",
  "/library",
  "/agents",
  "/skills",
  "/insights",
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
};

/**
 * Matches nested product paths (`/routines/:id`, `/insights/...`, `/inbox/...`)
 * plus channel deep links. Channels also lights when Myra land (`/`) is active.
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
  },
  {
    path: CHANNEL_PATH_PREFIX,
    label: "Channels",
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
    path: "/agents",
    label: "Agents",
    icon: <Bot />,
    render: (path: string, navigate: (to: string) => void) => (
      <AgentsRoute path={path} navigate={navigate} />
    ),
  },
  {
    path: "/skills",
    label: "Skills",
    icon: <Wand2 />,
    render: (path: string, navigate: (to: string) => void) => (
      <SkillsRoute path={path} navigate={navigate} />
    ),
  },
  {
    path: "/insights",
    label: "Insights",
    icon: <ChartColumn />,
    render: (path: string) => <InsightsRoute path={path} />,
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
