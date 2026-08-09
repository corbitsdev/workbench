// The route table: one entry per screen, consumed by both the sidebar (label,
// icon) and the route switch (render), so navigation and pages cannot drift
// apart. Settings renders like any other route but is reached from the
// sidebar's identity dock, not the top nav — `NAV_ROUTES` is what the nav
// list shows. Channel deep links (`/c/:channelId`) stay routable for the
// main-pane fallback when the canvas column is not available; the rail no
// longer lists Chat. Approvals no longer has a page at all — the `/approvals`
// route is gone and its actionable cards live inline in the contextual
// panel's notifications band.

import {
  Bot,
  ChartColumn,
  Home,
  Library,
  MessageSquare,
  Settings,
  Wand2,
  Workflow,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { CHANNEL_PATH_PREFIX, isChannelPath } from "./channel-path";
import { AgentsRoute } from "./pages/agents-page";
import { ChatPage } from "./pages/chat-page";
import { HomeRoute } from "./pages/home-page";
import { InsightsRoute } from "./pages/insights-page";
import { LibraryRoute } from "./pages/library-page";
import { RoutinesRoute } from "./pages/routines-page";
import { SettingsRoute } from "./pages/settings-page";
import { SkillsRoute } from "./pages/skills-page";

/** Landing point for a session the first-login hook just provisioned a
 * personal bench for. Not one of `APP_ROUTES`: it has no sidebar entry,
 * it is only ever reached by the first-login redirect. */
export const ONBOARDING_PATH = "/onboarding";

/** Settings lives in the sidebar's identity dock, not the top nav. */
export const SETTINGS_PATH = "/settings";

/** Paths the rail lists — product nav; channels open in the canvas.
 * Approvals has no route at all (notifications band owns its surface). */
const RAIL_NAV_PATHS = new Set([
  "/",
  "/routines",
  "/library",
  "/agents",
  "/skills",
  "/insights",
]);

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
 * Matches `/c` and `/c/:channelId` (plus the legacy `/chat` prefix), and
 * `/routines` / `/routines/:id`. Other routes are exact path matches.
 */
export function matchesRoute(routePath: string, path: string): boolean {
  if (routePath === CHANNEL_PATH_PREFIX) {
    return isChannelPath(path);
  }
  if (routePath === "/routines") {
    return path === "/routines" || path.startsWith("/routines/");
  }
  return routePath === path;
}

export const APP_ROUTES: readonly AppRoute[] = [
  { path: "/", label: "Home", icon: <Home />, render: () => <HomeRoute /> },
  {
    path: CHANNEL_PATH_PREFIX,
    label: "Channels",
    icon: <MessageSquare />,
    render: (path: string, navigate: (to: string) => void) => (
      <ChatPage path={path} navigate={navigate} />
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
    render: () => <LibraryRoute />,
  },
  {
    path: "/agents",
    label: "Agents",
    icon: <Bot />,
    render: () => <AgentsRoute />,
  },
  {
    path: "/skills",
    label: "Skills",
    icon: <Wand2 />,
    render: () => <SkillsRoute />,
  },
  {
    path: "/insights",
    label: "Insights",
    icon: <ChartColumn />,
    render: () => <InsightsRoute />,
  },
  {
    path: SETTINGS_PATH,
    label: "Settings",
    icon: <Settings />,
    render: () => <SettingsRoute />,
  },
];

/** What the rail lists: product pages only. Settings is the identity dock;
 * Channels stay deep-linkable but off the rail (canvas owns the surface).
 * Approvals has no route. */
export const NAV_ROUTES: readonly AppRoute[] = APP_ROUTES.filter((route) =>
  RAIL_NAV_PATHS.has(route.path),
);
