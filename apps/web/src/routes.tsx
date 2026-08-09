// The route table: one entry per screen, consumed by both the sidebar (label,
// icon) and the route switch (render), so navigation and pages cannot drift
// apart. Settings renders like any other route but is reached from the
// sidebar's identity dock, not the top nav — `NAV_ROUTES` is what the nav
// list shows. Chat stays routable for deep links but leaves the rail (the
// channel surface owns its next home). Approvals no longer has a page at all
// — the `/approvals` route is gone and its actionable cards live inline in
// the contextual panel's notifications band.

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

/** Paths the rail lists — product nav after Chat and Approvals leave the rail.
 * Approvals now has no route at all (notifications band owns its surface). */
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
 * Matches /chat and /chat/:channelId — the channel id segment is the
 * chat page's own concern; the shell only needs to know the page owns
 * the whole /chat prefix.
 */
export function matchesRoute(routePath: string, path: string): boolean {
  if (routePath === "/chat") {
    return path === "/chat" || path.startsWith("/chat/");
  }
  if (routePath === "/routines") {
    return path === "/routines" || path.startsWith("/routines/");
  }
  return routePath === path;
}

export const APP_ROUTES: readonly AppRoute[] = [
  { path: "/", label: "Home", icon: <Home />, render: () => <HomeRoute /> },
  {
    path: "/chat",
    label: "Chat",
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
 * Chat stays deep-linkable but off the rail. Approvals has no route. */
export const NAV_ROUTES: readonly AppRoute[] = APP_ROUTES.filter((route) =>
  RAIL_NAV_PATHS.has(route.path),
);
