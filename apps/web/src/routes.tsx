// The route table: one entry per screen, consumed by the command palette
// (label) and the route switch (render), so navigation and pages cannot
// drift apart. The sidebar itself lists workbenches (conversations), not
// routes — Plugins, Insights, and Settings are reached from its footer, and
// everything here also stays reachable by deep link and the palette.
// Conversation deep links (`/c/:channelId`) stay routable; `/` is the Myra
// land hop (ensure + open her conversation) for a bench with a workbench
// already, or the guided first-workbench describe screen for a bench with
// none (CL-6104) — never a Home dashboard.
// Approvals has no page — the Activity band owns them. Agents and Skills
// are Settings sections; `/agents` and `/skills` stay routable only as
// redirects to their new home, so old links and bookmarks still land
// somewhere real. Inbox is gone too (CL-6151: tasks + approvals don't flow
// into workbenches); `/inbox` stays routable only as a redirect to `/`.

import {
  Blocks,
  ChartColumn,
  Library,
  MessageSquare,
  SlidersHorizontal,
  Workflow,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { useEffect } from "react";

import { CHANNEL_PATH_PREFIX, isChannelPath } from "./channel-path";
import { ChatPage } from "./pages/chat-page";
import { HomeRoute } from "./pages/home-page";
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

/** Settings path — sidebar footer + settings page. */
export const SETTINGS_PATH = "/settings";

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
 * Matches nested product paths (`/routines/:id`, `/insights/...`) plus
 * conversation deep links (which also match when Myra land `/` is active).
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
    routePath === "/agents" ||
    routePath === "/skills" ||
    routePath === SETTINGS_PATH
  ) {
    return path === routePath || path.startsWith(`${routePath}/`);
  }
  return routePath === path;
}

/** Bounces old `/inbox` links and bookmarks home (CL-6151: the Inbox page
 * is gone — tasks and approvals don't flow into a workbench). */
function InboxRedirect({
  navigate,
}: {
  readonly navigate: (to: string) => void;
}) {
  useEffect(() => {
    navigate("/");
  }, [navigate]);
  return null;
}

export const APP_ROUTES: readonly AppRoute[] = [
  {
    path: "/",
    label: "New Workbench",
    icon: <MessageSquare />,
    render: () => <HomeRoute />,
    hasStageTopBar: false,
  },
  {
    path: CHANNEL_PATH_PREFIX,
    label: "Workbenches",
    icon: <MessageSquare />,
    render: (path: string, navigate: (to: string) => void) => (
      <ChatPage path={path} navigate={navigate} />
    ),
  },
  {
    path: "/inbox",
    label: "Inbox",
    icon: <MessageSquare />,
    render: (_path: string, navigate: (to: string) => void) => (
      <InboxRedirect navigate={navigate} />
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
    // Agents is a Settings section — this entry only keeps old `/agents`
    // links routable.
    path: "/agents",
    label: "Agents",
    icon: <SlidersHorizontal />,
    render: (path: string, navigate: (to: string) => void) => (
      <LegacyAgentsRedirect path={path} navigate={navigate} />
    ),
  },
  {
    // Skills is a Settings section — this entry only keeps old `/skills`
    // links routable.
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

/**
 * Everything the command palette treats as a product destination (its
 * "Pages" group). The sidebar footer reaches Inbox / Insights / Settings
 * directly; the rest are palette- and deep-link-reachable.
 */
export const NAV_ROUTES: readonly AppRoute[] = routesInOrder([
  CHANNEL_PATH_PREFIX,
  "/routines",
  "/library",
  "/insights",
  SETTINGS_PATH,
]);
